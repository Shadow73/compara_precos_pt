// Adapter: Lidl (lidl.pt) — HTTP puro, SEM Playwright
//
// DESCOBERTA (nov/2026): os resultados da pesquisa vêm EMBUTIDOS no HTML
// inicial (server-side rendering) — a app Vue faz "hydration" dos tiles que
// já estão na página; não há chamada XHR para os produtos da 1.ª página.
// Cada produto é um <div ... data-grid-data="{JSON escapado}"> com TUDO:
// nome, marca, preço, preço unitário, embalagem, promoção e URL.
//
// Por isso o Chromium deixou de ser preciso: um único GET devolve os mesmos
// produtos que o browser via (no teste: 5-8 tiles idênticos em ~0,5-2s,
// contra ~8-20s do caminho com Playwright, mais o arranque do browser).
//
// Cadeia de preço (nem todos os tiles têm o preço no mesmo sítio):
//   1) tile.price.price                          — preço "normal"
//   2) tile.regionsPrices["1"].currentPrice      — preço regional
//   3) tile.regionsPrices["1"].currentLidlPlusPrice.price — promo Lidl Plus
//      (última hipótese: alguns produtos SÓ têm este preço — ex. "Leite
//      Pastagem Meio-gordo" a 0,79 €, antes 1,07 €)
//
// Sem dependências: só `fetch` do Node (18+). Se o site deixar de embutir os
// produtos no HTML, o adapter devolve um erro claro em vez de dados vazios.

const BASE = 'https://www.lidl.pt';

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'pt-PT,pt;q=0.9',
};

const MAX_RESULTS = 30;
const TIMEOUT_MS = Number(process.env.LIDL_TIMEOUT_MS) > 0 ? Number(process.env.LIDL_TIMEOUT_MS) : 12000;
const ATTEMPTS = 2; // 1 retry para falhas de rede transitórias
const DEBUG = process.env.LIDL_DEBUG === 'true';

const log = (...args) => {
  if (DEBUG) console.log('[lidl]', ...args);
};

export async function searchLidl(query) {
  const url = `${BASE}/q/search?q=${encodeURIComponent(query)}`;
  const html = await fetchSearchHtml(url);

  const tiles = extractTiles(html);
  log(`${tiles.length} tiles no HTML`);

  let offers = tiles.map(tileToOffer).filter((o) => Number.isFinite(o.price) && o.price > 0);

  // Rede de segurança barata: JSON-LD embutido (se um dia os tiles mudarem)
  if (offers.length === 0) offers = parseJsonLdProducts(html);

  if (offers.length === 0) {
    throw new Error(
      `A pesquisa no lidl.pt não devolveu produtos para "${query}". ` +
        `O site pode ter deixado de embutir os resultados no HTML ` +
        `(estrutura mudou — abra ${url} no browser e confira; use LIDL_DEBUG=true para detalhe).`,
    );
  }

  const filtered = filterByQuery(offers, query);
  return dedupe(filtered).slice(0, MAX_RESULTS);
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

async function fetchSearchHtml(url) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const html = await res.text();
      log(`GET ${url} → ${res.status} (${(Date.now() - t0) / 1000}s, ${html.length} bytes, url final: ${res.url})`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return html;
    } catch (err) {
      lastErr = err;
      log(`tentativa ${attempt} falhou: ${err.message}`);
      if (attempt < ATTEMPTS) await sleep(600);
    }
  }
  throw new Error(`lidl.pt inacessível (${lastErr?.message ?? 'erro desconhecido'})`);
}

// ─── Extração dos tiles (data-grid-data) ────────────────────────────────────

// O atributo codifica as aspas como &quot;, pelo que o valor nunca contém
// aspas "vivas" — [^"]* captura o JSON completo com segurança.
// Nota: usa-se matchAll (não exec) — as pesquisas da cesta correm em
// paralelo e um regex /g partilhado com lastIndex seria um bug de
// concorrência entre chamadas simultâneas.
const GRID_DATA_RE = / data-grid-data="([^"]*)"/g;

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // por último: pode estar dentro de &amp;quot;
}

function extractTiles(html) {
  const tiles = [];
  for (const m of html.matchAll(GRID_DATA_RE)) {
    try {
      tiles.push(JSON.parse(decodeEntities(m[1])));
    } catch (err) {
      log(`tile ilegível: ${err.message}`);
    }
  }
  return tiles;
}

/** Converte um tile do data-grid-data na oferta padronizada dos adapters. */
function tileToOffer(t) {
  const priceObj = pickPriceObject(t);
  if (!priceObj) return { name: t.title, price: NaN }; // filtrado depois

  const name = String(t.title ?? t.fullTitle ?? '').replace(/\s+/g, ' ').trim();
  const price = Number(priceObj.price);
  const basePriceText = priceObj.basePrice?.text ?? t.price?.basePrice?.text ?? '';
  const um = String(basePriceText).match(/1\s*(kg|l|lt|un)\s*=\s*(\d+[.,]\d+)/i);

  // Promoção: preço "antes" (tachado) e/ou texto de desconto ("-21%")
  const disc = priceObj.discount ?? {};
  const oldPrice = Number(disc.deletedPrice);
  const promoBits = [];
  if (Number.isFinite(oldPrice) && oldPrice > price) promoBits.push(`antes ${formatPt(oldPrice)}`);
  if (typeof disc.discountText === 'string' && disc.discountText.trim()) {
    promoBits.push(disc.discountText.trim());
  }

  const href = t.canonicalPath ?? t.canonicalUrl;

  return {
    supermarket: 'Lidl',
    brand: t.brand?.name ?? guessBrand(name),
    name,
    price,
    unitPrice: um ? Number(um[2].replace(',', '.')) : undefined,
    unit: um ? um[1].replace('lt', 'l') : undefined,
    promo: promoBits.length ? promoBits.join(' · ') : undefined,
    url: href && typeof href === 'string' ? new URL(href, BASE).href : undefined,
  };
}

/**
 * Cadeia de preço: topo → regional → Lidl Plus. Devolve o objeto que tem o
 * número do preço (com basePrice/packaging/discount no mesmo sítio).
 */
function pickPriceObject(t) {
  if (Number.isFinite(Number(t.price?.price)) && Number(t.price?.price) > 0) return t.price;

  const reg = t.regionsPrices?.['1'] ?? {};
  const cur = reg.currentPrice;
  if (Number.isFinite(Number(cur?.price)) && Number(cur.price) > 0) return cur;

  const plus = reg.currentLidlPlusPrice?.price;
  if (Number.isFinite(Number(plus?.price)) && Number(plus.price) > 0) return plus;

  return null;
}

// ─── Rede de segurança: JSON-LD (se a estrutura dos tiles mudar) ────────────

function parseJsonLdProducts(html) {
  const offers = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const nodes = item?.['@type'] === 'ItemList' ? item.itemListElement : [item];
        for (const n of nodes) {
          const p = n?.item ?? n;
          if (p?.['@type'] !== 'Product' || !p?.name) continue;
          const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
          const price = Number(offer?.price ?? NaN);
          if (!Number.isFinite(price)) continue;
          offers.push({
            supermarket: 'Lidl',
            brand: p.brand?.name ?? guessBrand(p.name),
            name: p.name,
            price,
            url: p.url ? new URL(p.url, BASE).href : undefined,
          });
        }
      }
    } catch {
      // ignora
    }
  }
  return offers;
}

// ─── Utilitários (iguais ao resto do projeto) ───────────────────────────────

function filterByQuery(offers, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return offers;

  const matched = offers.filter((o) => {
    const hay = normalize(`${o.brand ?? ''} ${o.name}`);
    return words.every((w) => hay.includes(w));
  });

  return matched.length > 0 ? matched : offers;
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function formatPt(v) {
  return `${Number(v).toFixed(2).replace('.', ',')} €`;
}

function guessBrand(name) {
  const m = String(name).match(/^[A-ZÀ-Ý][\wà-ÿ’.-]*/);
  return m ? m[0] : '';
}

function dedupe(offers) {
  const seen = new Set();
  return offers.filter((o) => {
    const key = o.url || `${o.name}|${o.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
