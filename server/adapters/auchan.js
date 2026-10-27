// Adapter: Auchan (auchan.pt)
//
// As páginas de categoria/pesquisa do auchan.pt são HTML simples (só a
// navegação principal precisa de JS). Seletores confirmados no spider do
// projeto ProductScraper:
//   - tile:       div.product-tile
//   - nome:       a.link
//   - preço:      span.sales span.value[content] (fallback span.list span.value)
//   - preço/unid: span.auc-measures--price-per-unit (ex.: "1,25 €/kg")
//   - desconto:   span.list span.strike-through[content]
//   - ver mais:   button.auc-js-show-more-next-button[data-url]
//
// Nota: pode aparecer um banner de cookies (OneTrust) — os tiles vêm mesmo
// assim no HTML, mas se não vierem, aceitar cookies num browser primeiro
// resolve a questão.

import * as cheerio from 'cheerio';

const BASE = 'https://www.auchan.pt';

const SEARCH_URLS = [
  (q) => `${BASE}/pt/pesquisa?q=${encodeURIComponent(q)}`,
  (q) => `${BASE}/pt/search?q=${encodeURIComponent(q)}`,
  (q) => `${BASE}/pesquisa?q=${encodeURIComponent(q)}`,
];

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'pt-PT,pt;q=0.9',
};

const MAX_RESULTS = 30;

export async function searchAuchan(query) {
  let lastError = null;

  for (const buildUrl of SEARCH_URLS) {
    try {
      const res = await fetch(buildUrl(query), { headers: HEADERS });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const offers = parseTiles(html);
      if (offers.length === 0) {
        lastError = new Error('Resposta sem produtos (URL de pesquisa mudou?)');
        continue;
      }
      return offers.slice(0, MAX_RESULTS);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('Sem resultados');
}

function parseTiles(html) {
  const $ = cheerio.load(html);
  const offers = [];

  $('div.product-tile').each((_, el) => {
    const $el = $(el);

    const link = $el.find('a.link').first();
    const name = link.text().replace(/\s+/g, ' ').trim();
    if (!name) return;

    const priceAttr =
      $el.find('span.sales span.value').attr('content') ||
      $el.find('span.list span.value').attr('content');
    const price = parsePrice(priceAttr ?? '');
    if (price == null) return;

    // preço unitário: "1,25 €/kg"
    const unitText = $el.find('span.auc-measures--price-per-unit').first().text().trim();
    let unitPrice, unit;
    const parts = unitText.split(/\s+/);
    if (parts.length >= 2) {
      unitPrice = parsePrice(parts[0]);
      unit = parts[1];
    }

    const before = $el.find('span.list span.strike-through').attr('content');

    offers.push({
      supermarket: 'Auchan',
      brand: extractBrand(name),
      name,
      price,
      unitPrice: unitPrice ?? undefined,
      unit,
      promo: before ? `antes ${before}` : undefined,
      url: link.attr('href')
        ? new URL(link.attr('href'), BASE).href
        : undefined,
    });
  });

  return offers;
}

function extractBrand(name) {
  if (/^auchan\b/i.test(name)) return 'Auchan';
  const m = name.match(/^[A-ZÀ-Ý][\wà-ÿ'’.-]*/);
  return m ? m[0] : '';
}

function parsePrice(text) {
  const m = String(text).replace(/\s/g, '').replace(',', '.').match(/(\d+(\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}
