// Backend Express — comparação de preços + cesta de compras.
//
// GET  /api/search?q=...   → preços de um produto em todas as superfícies
// POST /api/basket         → { items: ["arroz", "leite", ...] } devolve,
//                            por artigo, o mais barato em cada superfície e
//                            o total da cesta por superfície com diferenças.
//
// As pesquisas usam cache em memória (30 min): scraping é caro (segundos
// por cadeia), e a cesta reaproveita pesquisas do separador "Comparar".

import express from 'express';
import { searchContinente } from './adapters/continente.js';
import { searchPingoDoce } from './adapters/pingodoce.js';
import { searchAuchan } from './adapters/auchan.js';
import { searchLidl } from './adapters/lidl.js';
// Intermarché retirado da comparação (DataDome bloqueia IPs de datacenter;
// só viável em localhost com cookie + stealth). O ficheiro do adapter fica
// no projeto para uso local.
import { searchDemo } from './adapters/demo.js';
import { closeBrowser } from './browser.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '64kb' }));

// timeoutMs: adapters com browser precisam de muito tempo em máquinas
// pequenas (ex.: 512 MB do Render gratuito). O browser fica reutilizado
// entre pesquisas — só a PRIMEIRA pesquisa após arranque é lenta.
const adapters = [
  { name: 'Continente', fn: searchContinente, timeoutMs: 120000 },
  { name: 'Pingo Doce', fn: searchPingoDoce },
  { name: 'Auchan', fn: searchAuchan },
  { name: 'Lidl', fn: searchLidl, timeoutMs: 120000 },
];

// CORS: o frontend no Vercel chama este backend noutro domínio.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Cache em memória ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function cacheKey(q) {
  return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

async function searchAll(query) {
  const key = cacheKey(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

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

  offers.sort((a, b) => a.price - b.price);
  const data = { query, offers, errors };
  cache.set(key, { ts: Date.now(), data });

  // Limpeza simples quando o mapa cresce demais
  if (cache.size > 400) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of cache) {
      if (v.ts < cutoff) cache.delete(k);
    }
  }

  return data;
}

// ── Pesquisa simples ─────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Parâmetro "q" em falta.' });
  }

  if (process.env.DEMO_MODE === 'true') {
    return res.json({ query, offers: searchDemo(query), errors: [] });
  }

  res.json(await searchAll(query));
});

// ── Cesta de compras ─────────────────────────────────────────────────────────

app.post('/api/basket', async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Envie { "items": ["arroz agulha", ...] }.' });
  }

  const queries = [...new Set(items.map((i) => String(i).trim()).filter(Boolean))].slice(0, 20);
  if (queries.length === 0) {
    return res.status(400).json({ error: 'Lista vazia.' });
  }

  // Todas as pesquisas em paralelo — com cache, a 2.ª comparação da mesma
  // lista é quase instantânea.
  const results = await Promise.all(queries.map((q) => searchAll(q)));

  // Para cada artigo: o preço mais baixo em CADA superfície
  const perItem = results.map(({ query, offers }) => {
    const cheapest = {};
    for (const o of offers) {
      const cur = cheapest[o.supermarket];
      if (!cur || o.price < cur.price) {
        cheapest[o.supermarket] = {
          price: o.price,
          name: o.name,
          brand: o.brand,
          url: o.url,
        };
      }
    }
    return { query, cheapest };
  });

  // Total da cesta por superfície (+ artigos em falta)
  const totals = adapters.map(({ name }) => {
    let total = 0;
    const missing = [];
    for (const item of perItem) {
      const c = item.cheapest[name];
      if (c) total += c.price;
      else missing.push(item.query);
    }
    return {
      supermarket: name,
      total: round2(total),
      count: perItem.length - missing.length,
      totalItems: perItem.length,
      missing,
    };
  });

  const eligible = totals.filter((t) => t.count > 0);
  const best = eligible.length ? Math.min(...eligible.map((t) => t.total)) : null;

  const summary = totals
    .map((t) => ({
      ...t,
      isCheapest: best !== null && t.total === best,
      diff: best !== null ? round2(t.total - best) : null,
      diffPct: best !== null && best > 0 ? round2(((t.total - best) / best) * 100) : null,
    }))
    .sort((a, b) => {
      if (a.count === 0 && b.count === 0) return 0;
      if (a.count === 0) return 1;   // sem artigos → fim da tabela
      if (b.count === 0) return -1;
      return a.total - b.total;
    });

  res.json({
    items: perItem,
    summary,
    cheapestSupermarket: summary.find((s) => s.isCheapest)?.supermarket ?? null,
    errors: results.flatMap((r) => r.errors),
  });
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

app.listen(PORT, () => {
  console.log(`API em http://localhost:${PORT} (/api/search e /api/basket)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeBrowser().finally(() => process.exit(0));
  });
}
