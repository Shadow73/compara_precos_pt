// Backend Express — comparação de preços + cesta de compras.
//
// GET  /api/search?q=...   → preços de um produto em todas as superfícies
// POST /api/basket         → { items: ["arroz", "leite", ...] } devolve,
//                            por artigo, o mais barato em cada superfície e
//                            o total da cesta por superfície com diferenças.
//                            Só superfícies com TODOS os artigos da cesta são
//                            elegíveis como "mais barata" (campo complete).
//
// PERFORMANCE (o scraping demora segundos por cadeia — ver também .env.example):
//   - cache em memória com TTL configurável (CACHE_TTL_MINUTES, default 30)
//   - stale-while-revalidate: termo com cache expirado devolve os preços
//     ANTIGOS imediatamente e renova em background (resposta com stale:true)
//   - dedup de pesquisas concorrentes do mesmo termo (in-flight)
//   - cache em DISCO (DISK_CACHE, default ligado) — sobrevive a reinícios
//   - respostas de falha total (0 produtos + erros) NÃO ficam em cache
//   - erros em cache AUTO-CURAM-SE: repetem-se só as superfícies que falharam
//     (um erro antigo nunca é servido como atual; cooldown de 10 min)
//   - limite de pesquisas simultâneas no browser por superfície
//     (BROWSER_CONCURRENCY, default 4) — evita thrashing em cestas grandes

import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { searchContinente } from './adapters/continente.js';
import { searchPingoDoce } from './adapters/pingoDoce.js'; // nome real do ficheiro (Linux é case-sensitive)
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

// ── Configuração de performance (variáveis de ambiente) ─────────────────────
const numEnv = (name) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

const CACHE_TTL_MS = (numEnv('CACHE_TTL_MINUTES') ?? 30) * 60 * 1000;
const GLOBAL_TIMEOUT_MS = numEnv('ADAPTER_TIMEOUT_MS'); // sobrepõe todos os defaults
const BROWSER_CONCURRENCY = numEnv('BROWSER_CONCURRENCY') ?? 4;
const DISK_CACHE = process.env.DISK_CACHE !== 'false';
const DISK_CACHE_PATH =
  process.env.DISK_CACHE_PATH ?? path.resolve(process.cwd(), 'data', 'price-cache.json');
const DISK_MAX_ENTRIES = 500;
const DISK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // no disco, descarta entradas com mais de 24h

const adapters = [
  { name: 'Continente', fn: searchContinente, browser: true },
  { name: 'Pingo Doce', fn: searchPingoDoce },
  { name: 'Auchan', fn: searchAuchan },
  { name: 'Lidl', fn: searchLidl }, // HTTP puro — sem browser (ver adapters/lidl.js)
].map((a) => ({
  ...a,
  // Browser precisa de muito mais tempo que HTTP; 45s (em vez dos 120s
  // anteriores) basta para o Chromium renderizar e mantém o pior caso
  // de resposta da API muito mais curto.
  timeoutMs: GLOBAL_TIMEOUT_MS ?? (a.browser ? 45000 : 15000),
  // Só os adapters de browser partilham o mesmo Chromium: limitar as
  // pesquisas simultâneas evita abrir dezenas de páginas ao mesmo tempo.
  limiter: a.browser ? makeLimiter(BROWSER_CONCURRENCY) : null,
}));

// CORS: o frontend no Vercel chama este backend noutro domínio.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Cache: memória + disco + stale-while-revalidate + dedup in-flight ───────
const cache = new Map(); // key -> { ts, data }
const inflight = new Map(); // key -> Promise (pesquisa em curso)

function cacheKey(q) {
  return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

async function searchAll(query) {
  const key = cacheKey(query);
  const hit = cache.get(key);

  if (hit) {
    // Erros em cache são diagnóstico do MOMENTO em que a entrada foi criada
    // (ex.: "browser bloqueado" gravado antes de uma correção de adapter —
    // ou antes de o Playwright ser instalado). Nunca se servem como atuais:
    // re-correm-se SÓ as superfícies que falharam e funde-se o resultado.
    const data = await healCachedErrors(key, hit, query);

    if (Date.now() - hit.ts < CACHE_TTL_MS) return data; // fresco → instantâneo
    // Stale-while-revalidate: devolve os preços que já temos (instantâneo) e
    // renova em background — o utilizador nunca espera pelo scraping.
    refreshInBackground(key, query);
    return { ...data, stale: true };
  }
  return startSearch(key, query);
}

// ── Auto-cura de erros em cache ─────────────────────────────────────────────
//
// Um erro gravado na cache (memória ou disco — o disco aguenta 24h!) pode
// ficar desatualizado: a causa pode ter sido corrigida entretanto (adapter
// reescrito, browser instalado, rede recuperada). Em vez de mostrar o erro
// para sempre, repete-se APENAS as superfícies que falharam — as que já têm
// preços em cache não voltam a ser pesquisadas (a resposta continua quase
// instantânea). Cooldown de 10 min para não martelar em cada pedido uma
// superfície definitivamente avariada.
const HEAL_COOLDOWN_MS = 10 * 60 * 1000;

async function healCachedErrors(key, hit, query) {
  const errors = hit.data?.errors ?? [];
  if (errors.length === 0) return hit.data;

  const adapterNames = new Set(adapters.map((a) => a.name));
  const failedNames = [...new Set(errors.map((e) => e.supermarket))].filter((n) =>
    adapterNames.has(n),
  );
  const toRetry = adapters.filter((a) => failedNames.includes(a.name));

  // Só restam erros de superfícies que já nem existem no projeto → limpa.
  if (toRetry.length === 0) {
    const data = { ...hit.data, errors: [] };
    cache.set(key, { ...hit, data });
    scheduleDiskSave();
    return data;
  }

  if (Date.now() - (hit.lastHealTs ?? 0) < HEAL_COOLDOWN_MS) return hit.data;

  // Dedup: N pedidos concorrentes do mesmo termo partilham a mesma cura.
  const healKey = `heal:${key}`;
  if (inflight.has(healKey)) return inflight.get(healKey);

  const p = (async () => {
    const results = await Promise.allSettled(
      toRetry.map((a) =>
        withTimeout(runAdapter(a, query), a.timeoutMs, `${a.name} demorou demais`),
      ),
    );

    // Uma superfície ou tem ofertas ou tem erro — nunca ambos — pelo que a
    // fusão é limpa: as ofertas em cache das restantes + o resultado novo.
    const offers = [...(hit.data.offers ?? [])];
    const newErrors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        offers.push(...r.value);
      } else {
        newErrors.push({
          supermarket: toRetry[i].name,
          reason: r.reason?.message ?? 'Erro desconhecido',
        });
      }
    });
    offers.sort((a, b) => a.price - b.price);

    const data = { query: hit.data.query ?? query, offers, errors: newErrors };
    // O ts original mantém-se: curar um erro não "refresca" a idade dos
    // preços (o TTL de preços continua a contar desde a última pesquisa).
    cache.set(key, { ...hit, lastHealTs: Date.now(), data });
    scheduleDiskSave();
    return data;
  })().finally(() => inflight.delete(healKey));

  inflight.set(healKey, p);
  return p;
}

function refreshInBackground(key, query) {
  if (inflight.has(key)) return; // já há uma renovação em curso
  const p = doSearch(query)
    .catch((err) => console.error('[cache] revalidação falhou:', err?.message ?? err))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

function startSearch(key, query) {
  // Dedup: N pedidos concorrentes do mesmo termo disparam 1 único scraping.
  if (inflight.has(key)) return inflight.get(key);
  const p = doSearch(query).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doSearch(query) {
  const key = cacheKey(query);

  // Cada adapter tem timeout: uma cadeia lenta/sem resposta não pode
  // bloquear a comparação das restantes.
  const results = await Promise.allSettled(
    adapters.map((a) =>
      withTimeout(runAdapter(a, query), a.timeoutMs, `${a.name} demorou demais`),
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

  // Falha total (0 produtos + erros das cadeias) não fica em cache: pode ser
  // um bloqueio temporário (anti-bot/rede) e travaria a pesquisa 30 minutos.
  if (offers.length > 0 || errors.length === 0) {
    cache.set(key, { ts: Date.now(), data });
    scheduleDiskSave();
  }
  return data;
}

async function runAdapter(a, query) {
  if (!a.limiter) return a.fn(query);
  // Em cestas grandes, dezenas de páginas de browser em paralelo causam
  // thrashing (mais lento, não mais rápido) — fila por superfície.
  return a.limiter(() => a.fn(query));
}

// ── Cache em disco (data/price-cache.json, escrita atómica) ─────────────────
let diskSaveTimer = null;

function scheduleDiskSave() {
  if (!DISK_CACHE || diskSaveTimer) return;
  diskSaveTimer = setTimeout(() => {
    diskSaveTimer = null;
    persistCache();
  }, 3000); // debounce: uma cesta grande grava uma vez, não 20
}

async function persistCache() {
  if (!DISK_CACHE) return;
  try {
    const entries = [...cache.entries()]
      .filter(([, v]) => Date.now() - v.ts < DISK_MAX_AGE_MS)
      .sort((a, b) => b[1].ts - a[1].ts) // mais recentes primeiro
      .slice(0, DISK_MAX_ENTRIES);
    await mkdir(path.dirname(DISK_CACHE_PATH), { recursive: true });
    const tmp = `${DISK_CACHE_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(entries));
    await rename(tmp, DISK_CACHE_PATH);
  } catch (err) {
    console.error('[cache] falha ao gravar em disco:', err?.message ?? err);
  }
}

async function loadDiskCache() {
  if (!DISK_CACHE) return;
  try {
    const entries = JSON.parse(await readFile(DISK_CACHE_PATH, 'utf8'));
    if (!Array.isArray(entries)) return;
    let n = 0;
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || !v?.data) continue;
      if (Date.now() - (v.ts ?? 0) >= DISK_MAX_AGE_MS) continue;
      // Entradas expiradas também contam: servem via stale-while-revalidate
      // (instantâneo) enquanto o scraping renovado corre em background.
      cache.set(k, v);
      n++;
    }
    if (n > 0) console.log(`[cache] ${n} termos carregados do disco (${DISK_CACHE_PATH})`);
  } catch {
    // sem ficheiro (1.ª execução) ou inválido — normal, ignora
  }
}

// ── Limiter de concorrência (por adapter de browser) ─────────────────────────
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  return (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(() => {
          active--;
          queue.shift()?.();
        });
      };
      if (active < max) run();
      else queue.push(run);
    });
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

  try {
    res.json(await searchAll(query));
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Erro interno' });
  }
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
  try {
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

    // Elegibilidade: só superfícies com TODOS os artigos da cesta entram na
    // disputa de "mais barata". Uma superfície com 1/3 ou 2/3 dos artigos fica
    // de fora — o total parcial não é comparável com o total de uma cesta
    // completa (senão a que tem menos artigos pareceria sempre a mais barata).
    const isComplete = (t) => t.totalItems > 0 && t.count === t.totalItems;
    const eligible = totals.filter(isComplete);
    const best = eligible.length ? Math.min(...eligible.map((t) => t.total)) : null;

    const summary = totals
      .map((t) => ({
        ...t,
        complete: isComplete(t),
        isCheapest: best !== null && isComplete(t) && t.total === best,
        // Diferenças só fazem sentido entre cestas completas comparáveis.
        diff: best !== null && isComplete(t) ? round2(t.total - best) : null,
        diffPct:
          best !== null && isComplete(t) && best > 0
            ? round2(((t.total - best) / best) * 100)
            : null,
      }))
      .sort((a, b) => {
        // Cestas completas primeiro (por preço); depois as incompletas,
        // ordenadas por mais artigos encontrados.
        if (a.complete !== b.complete) return a.complete ? -1 : 1;
        if (a.complete) return a.total - b.total;
        if (a.count !== b.count) return b.count - a.count;
        return a.missing.length - b.missing.length;
      });

    res.json({
      items: perItem,
      summary,
      cheapestSupermarket: summary.find((s) => s.isCheapest)?.supermarket ?? null,
      errors: results.flatMap((r) => r.errors),
    });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Erro interno' });
  }
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

await loadDiskCache();

app.listen(PORT, () => {
  console.log(`API em http://localhost:${PORT} (/api/search e /api/basket)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Grava a cache pendente antes de sair (também corre periodicamente).
    persistCache().finally(() => closeBrowser().finally(() => process.exit(0)));
  });
}
