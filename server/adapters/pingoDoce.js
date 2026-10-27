// Adapter: Pingo Doce (pingodoce.pt)
//
// CONFIRMADO EM PRODUÇÃO (out/2026):
//   A pesquisa funciona via endpoint Demandware/SFCC:
//     https://www.pingodoce.pt/on/demandware.store/Sites-pingo-doce-Site/default/Search-Show?q=<termo>
//   Devolve HTML server-side com os resultados (ex.: "27 Resultados para
//   'esparguete'"). Os tiles usam exatamente os seletores do spider do
//   projeto ProductScraper:
//     - tile:      div.product-tile-pd
//     - nome:      div.product-name-link a
//     - marca:     div.product-brand-name
//     - preço:     span.sales .value (atributo content ou texto)
//     - unid.:     div.product-unit  (ex.: "1 Kg | 1,25 €/kg")
//     - desconto:  div.product-price .strike-through .value
//   Paginação: parâmetro ?start=N (12 por página).

import * as cheerio from 'cheerio';

const BASE = 'https://www.pingodoce.pt';

// Confirmado: o site ID do Demandware é "pingo-doce"
const SEARCH_URLS = [
  (q) =>
    `${BASE}/on/demandware.store/Sites-pingo-doce-Site/default/Search-Show?q=${encodeURIComponent(q)}`,
  (q) => `${BASE}/pesquisa?q=${encodeURIComponent(q)}`,
];

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'pt-PT,pt;q=0.9',
};

const MAX_RESULTS = 30;
const PAGE_SIZE = 12;

export async function searchPingoDoce(query) {
  let lastError = null;

  for (const buildUrl of SEARCH_URLS) {
    try {
      const res = await fetch(buildUrl(query), { headers: HEADERS });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const offers = parseTiles(await res.text());
      if (offers.length === 0) {
        lastError = new Error('Resposta sem produtos (anti-bot ou URL de pesquisa mudou)');
        continue;
      }

      // Segunda página (start=12) se ainda não chegámos ao máximo
      if (offers.length === PAGE_SIZE && offers.length < MAX_RESULTS) {
        try {
          const sep = buildUrl(query).includes('?') ? '&' : '?';
          const page2 = await fetch(`${buildUrl(query)}${sep}start=${PAGE_SIZE}`, { headers: HEADERS });
          if (page2.ok) offers.push(...parseTiles(await page2.text()));
        } catch {
          // página extra é opcional
        }
      }

      return dedupe(offers).slice(0, MAX_RESULTS);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('Sem resultados');
}

function parseTiles(html) {
  const $ = cheerio.load(html);
  const offers = [];

  $('div.product-tile-pd').each((_, el) => {
    const $el = $(el);

    const name = $el.find('div.product-name-link a').first().text().replace(/\s+/g, ' ').trim();
    if (!name) return;

    const brand = $el.find('div.product-brand-name').first().text().trim();

    // preço principal: atributo content do <span class="value"> dentro de .sales
    const priceAttr = $el.find('span.sales .value').attr('content');
    const priceText = priceAttr || $el.find('span.sales').first().text();
    const price = parsePrice(priceText);
    if (price == null) return;

    // "0.2 Kg | 11,45 €/Kg" → unidade + preço unitário
    const unitText = $el.find('div.product-unit').first().text().replace(/\s+/g, ' ').trim();
    let unitPrice, unit;
    const parts = unitText.split('|').map((s) => s.trim());
    if (parts.length === 2) {
      const m = parts[1].match(/(\d+[,.]\d+)\s*€\s*\/\s*([a-zA-Z]+)/);
      if (m) {
        unitPrice = Number(m[1].replace(',', '.'));
        unit = m[2];
      }
    }

    // promoção: preço antes do desconto
    const before = $el.find('div.product-price .strike-through .value').attr('content');
    const promo = before ? `antes ${before}` : undefined;

    const href = $el.find('div.product-name-link a').first().attr('href');

    offers.push({
      supermarket: 'Pingo Doce',
      brand,
      name,
      price,
      unitPrice,
      unit,
      promo,
      url: href ? new URL(href, BASE).href : undefined,
    });
  });

  return offers;
}

function dedupe(offers) {
  const seen = new Set();
  return offers.filter((o) => {
    const key = o.url || o.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePrice(text) {
  const m = String(text).replace(/\s/g, '').replace(',', '.').match(/(\d+(\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}
