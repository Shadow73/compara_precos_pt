// Adapter: Continente (continente.pt) — com duas estratégias
//
// 1) HTTP — fetch simples + cheerio. Rápido, mas o Continente serve a
//    pesquisa como SPA, pelo que o HTML bruto raramente tem produtos.
// 2) BROWSER — Playwright com perfil persistente (server/browser.js).
//
// ESTRUTURA REAL (confirmada com debug/ em out/2026):
//   <div class="product-tile ..." data-product-tile-impression="{"name":…,
//        "id":…, "price":4.29, "brand":"Continente", "category":…}">
//     link:     a[href*="/produto/"]            → /produto/<slug>-<id>.html
//     preço:    .pwc-tile--price-primary        → "4,29€"
//     promo:    .strike-through .value         → texto "4,69€" (preço anterior)
//     unidade:  .pwc-tile--price-secondary     → "5,72€/lt"
//   O JSON do atributo data-product-tile-impression é a fonte principal:
//   nome, preço e marca exatos, sem parsing de texto.

import * as cheerio from 'cheerio';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fetchRendered } from '../browser.js';

const BASE = 'https://www.continente.pt';
const SEARCH_URL = (q) => `${BASE}/pesquisa/?q=${encodeURIComponent(q)}`;

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'pt-PT,pt;q=0.9',
};

const MAX_RESULTS = 30;
const strategy = process.env.CONTINENTE_STRATEGY ?? 'auto';

// O HTML da pesquisa é uma SPA: o HTTP simples quase nunca devolve produtos.
// Depois de 3 tentativas seguidas sem sucesso, o modo "auto" passa a ir
// diretamente ao browser — poupa o custo do fetch+parse em cada pesquisa.
// (Reinicia com o processo; se o HTTP voltar a funcionar, a conta zera.)
let httpMissStreak = 0;
const HTTP_SKIP_AFTER_MISSES = 3;

export async function searchContinente(query) {
  const useHttp =
    strategy === 'http' || (strategy === 'auto' && httpMissStreak < HTTP_SKIP_AFTER_MISSES);

  let httpResult = null;
  if (useHttp) {
    httpResult = await tryHttp(query);
    if (httpResult.offers.length > 0) {
      httpMissStreak = 0; // o HTTP funcionou — volta a ser o caminho rápido
      return httpResult.offers.slice(0, MAX_RESULTS);
    }
    httpMissStreak++;
  }

  if (strategy === 'http') {
    throw httpResult?.error ?? new Error('HTTP sem resultados');
  }

  try {
    return await searchWithBrowser(query);
  } catch (err) {
    if (httpResult?.error) {
      throw new Error(`HTTP: ${httpResult.error.message} · Browser: ${err.message}`);
    }
    throw err;
  }
}

// ─── Estratégia HTTP ────────────────────────────────────────────────────────

async function tryHttp(query) {
  try {
    const res = await fetch(SEARCH_URL(query), {
      headers: HEADERS,
      // Sem isto, uma ligação pendurada bloqueia até ao timeout do adapter
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { offers: [], error: new Error(`HTTP ${res.status}`) };
    const offers = parseOffers(await res.text());
    return {
      offers,
      error: offers.length === 0 ? new Error('HTML sem produtos (SPA — usar browser)') : null,
    };
  } catch (err) {
    return { offers: [], error: err };
  }
}

// ─── Estratégia Browser (Playwright) ───────────────────────────────────────

async function searchWithBrowser(query) {
  let page;
  try {
    page = await fetchRendered(SEARCH_URL(query), {
      waitSelector: '[data-product-tile-impression]',
      waitForText: '€',
      acceptCookies: true,
      // domcontentloaded + waitSelector é muito mais rápido que networkidle
      // (analytics/beacons mantêm a rede "ocupada" durante segundos, o que
      // faz o networkidle esperar muito mais do que o necessário)
      waitUntil: 'domcontentloaded',
    });
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message)) {
      throw new Error(
        'Playwright não instalado — corra: npm i playwright && npx playwright install chromium',
      );
    }
    throw err;
  }

  const offers = parseOffers(page.html);
  if (offers.length === 0) {
    // Só aqui (parse falhou) é que vale a pena guardar o HTML para diagnóstico
    const htmlPath = await saveHtmlDebug(page.html, 'continente-parse');
    throw new Error(
      `A página "${page.title}" tem resultados mas o parser não os reconheceu. ` +
        (htmlPath
          ? `HTML guardado em ${htmlPath} para atualizar os seletores.`
          : 'Reenvie a pesquisa ou ative DEBUG_ARTIFACTS=true para diagnóstico.'),
    );
  }
  return offers.slice(0, MAX_RESULTS);
}

// Grava o HTML em debug/ apenas quando o parsing falha (diagnóstico raro).
async function saveHtmlDebug(html, name) {
  try {
    const dir = path.resolve(process.cwd(), 'debug');
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, `${name}-${Date.now()}.html`);
    await writeFile(p, html, 'utf8');
    return p;
  } catch {
    return null;
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseOffers(html) {
  const $ = cheerio.load(html);

  // 1) JSON estruturado em cada tile (fonte principal)
  const fromJson = parseFromTileJson($);
  if (fromJson.length > 0) return dedupe(fromJson);

  // 2) Seletores clássicos de tiles
  const fromTiles = parseFromTiles($);
  if (fromTiles.length > 0) return dedupe(fromTiles);

  // 3) JSON-LD embutido
  const fromLd = parseJsonLd(html);
  if (fromLd.length > 0) return dedupe(fromLd);

  // 4) Genérico: links /produto/ + preço no contentor ascendente
  return dedupe(parseFromLinks($));
}

// <div ... data-product-tile-impression="{"name":…,"price":4.29,"brand":…}">
function parseFromTileJson($) {
  const offers = [];

  $('[data-product-tile-impression]').each((_, el) => {
    const $el = $(el);
    let data;
    try {
      data = JSON.parse($el.attr('data-product-tile-impression'));
    } catch {
      return;
    }
    if (!data?.name || !Number.isFinite(Number(data.price))) return;

    const href = $el.find('a[href*="/produto/"]').first().attr('href') ?? '';
    const secondary = $el.find('.pwc-tile--price-secondary').first().text();
    const unitMatch = secondary.match(/(\d+[,.]\d+)\s*€\s*\/\s*([a-zA-Z]+)/);
    const strike = $el.find('.strike-through .value').first().text().trim();

    offers.push({
      supermarket: 'Continente',
      brand: data.brand || extractBrand(data.name),
      name: data.name,
      price: Number(data.price),
      unitPrice: unitMatch ? Number(unitMatch[1].replace(',', '.')) : undefined,
      unit: unitMatch ? unitMatch[2] : undefined,
      promo: strike ? `antes ${strike}` : undefined,
      url: href ? new URL(href.split('?')[0], BASE).href : undefined,
    });
  });

  return offers;
}

function parseFromTiles($) {
  const offers = [];

  for (const sel of ['.ct-inner-tile-wrap', '.product-tile', '.grid-tile']) {
    const tiles = $(sel);
    if (tiles.length === 0) continue;

    tiles.each((_, el) => {
      const $el = $(el);
      const link = $el.find('a[href*="/produto/"]').first();
      const href = link.attr('href') || '';
      const name = link.text().replace(/\s+/g, ' ').trim();
      if (!href || name.length < 3) return;

      const priceText = $el.find('.pwc-tile--price-primary').first().text();
      const priceMatch = priceText.match(/(\d+[,.]\d+)\s*€/);
      if (!priceMatch) return;

      const secondary = $el.find('.pwc-tile--price-secondary').first().text();
      const unitMatch = secondary.match(/(\d+[,.]\d+)\s*€\s*\/\s*([a-zA-Z]+)/);

      offers.push({
        supermarket: 'Continente',
        brand: extractBrand(name),
        name,
        price: Number(priceMatch[1].replace(',', '.')),
        unitPrice: unitMatch ? Number(unitMatch[1].replace(',', '.')) : undefined,
        unit: unitMatch ? unitMatch[2] : undefined,
        url: new URL(href.split('?')[0], BASE).href,
      });
    });

    if (offers.length > 0) break;
  }

  return offers;
}

function parseFromLinks($) {
  const offers = [];

  $('a[href*="/produto/"]').each((_, el) => {
    const $link = $(el);
    const name = $link.text().replace(/\s+/g, ' ').trim();
    const href = $link.attr('href') || '';
    if (name.length < 4 || !href) return;

    let node = $link.parent();
    let price = null;
    let unit = null;
    for (let i = 0; i < 6 && node.length; i++) {
      const priceText = node.find('.pwc-tile--price-primary').first().text();
      const m = priceText.match(/(\d+[,.]\d+)\s*€/) ??
        node.text().match(/(\d+[,.]\d+)\s*€/);
      if (m && node.text().length < 500) {
        price = Number(m[1].replace(',', '.'));
        const u = node.text().match(/(\d+[,.]\d+)\s*€\s*\/\s*([a-zA-Z]+)/);
        if (u) unit = { value: Number(u[1].replace(',', '.')), unit: u[2] };
        break;
      }
      node = node.parent();
    }
    if (price == null) return;

    offers.push({
      supermarket: 'Continente',
      brand: extractBrand(name),
      name,
      price,
      unitPrice: unit?.value,
      unit: unit?.unit,
      url: new URL(href.split('?')[0], BASE).href,
    });
  });

  return offers;
}

function parseJsonLd(html) {
  const offers = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const nodes =
          item?.['@type'] === 'ItemList'
            ? item.itemListElement
            : Array.isArray(item)
              ? item
              : [item];
        for (const n of nodes) {
          const p = n?.item ?? n;
          if (!p?.name || p['@type'] !== 'Product') continue;
          const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
          const price = Number(offer?.price ?? NaN);
          if (!Number.isFinite(price)) continue;
          offers.push({
            supermarket: 'Continente',
            brand: p.brand?.name ?? extractBrand(p.name),
            name: p.name,
            price,
            url: p.url ? new URL(p.url, BASE).href : undefined,
          });
        }
      }
    } catch {
      // ignora blocos inválidos
    }
  }
  return offers;
}

function extractBrand(name) {
  if (/^continente\b/i.test(name)) return 'Continente';
  const m = name.match(/^[A-ZÀ-Ý][\wà-ÿ’.-]*/);
  return m ? m[0] : '';
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
