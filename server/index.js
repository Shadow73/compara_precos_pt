// Backend Express — ponto de entrada.
// Recebe /api/search?q=..., repete a pesquisa em TODOS os supermercados
// em paralelo (Promise.allSettled: se um falhar, os restantes continuam),
// normaliza tudo para um formato comum e devolve JSON ao frontend.

import express from 'express';
import { searchContinente } from './adapters/continente.js';
import { searchPingoDoce } from './adapters/pingoDoce.js';
import { searchAuchan } from './adapters/auchan.js';
import { searchLidl } from './adapters/lidl.js';
import { searchIntermarche } from './adapters/intermarche.js';
import { searchDemo } from './adapters/demo.js';
import { closeBrowser } from './browser.js';

const app = express();
const PORT = process.env.PORT || 3001;

// timeoutMs: adapters com browser/anti-bot precisam de mais tempo que os
// de HTTP simples. O timeout por omissão (15 s) aplica-se ao resto.
const adapters = [
  { name: 'Continente', fn: searchContinente, timeoutMs: 45000 },
  { name: 'Pingo Doce', fn: searchPingoDoce },
  { name: 'Auchan', fn: searchAuchan },
  { name: 'Lidl', fn: searchLidl, timeoutMs: 45000 },
  { name: 'Intermarché', fn: searchIntermarche, timeoutMs: 60000 },
];

// CORS: o frontend no Vercel chama este backend noutro domínio.
// Em dev não é necessário (o Vite faz proxy), mas não prejudica.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Parâmetro "q" em falta.' });
  }

  // DEMO_MODE=true permite desenvolver a UI sem tocar nos sites reais.
  if (process.env.DEMO_MODE === 'true') {
    return res.json({ query, offers: searchDemo(query), errors: [] });
  }

  // Cada adapter tem timeout: uma cadeia lenta/sem resposta não pode
  // bloquear a comparação das restantes.
  const results = await Promise.allSettled(
    adapters.map((a) =>
      withTimeout(a.fn(query), a.timeoutMs ?? 15000, `${a.name} demorou demais`),
    ),
  );

  const offers = [];
  const errors = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      offers.push(...r.value);
    } else {
      console.error(`[${adapters[i].name}]`, r.reason?.message);
      errors.push({
        supermarket: adapters[i].name,
        reason: r.reason?.message ?? 'Erro desconhecido',
      });
    }
  });

  // Ordenação global por preço (o frontend também re-ordena se quiser).
  offers.sort((a, b) => a.price - b.price);

  res.json({ query, offers, errors });
});

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

app.listen(PORT, () => {
  console.log(`API de comparação em http://localhost:${PORT}/api/search`);
});

// Garante que o browser Playwright (se usado pelo adapter Continente)
// não fica pendurado quando o servidor termina.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeBrowser().finally(() => process.exit(0));
  });
}
