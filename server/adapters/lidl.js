// Adapter: Lidl (lidl.pt) — pesquisa no browser com captura da API JSON
//
// DIAGNÓSTICO (debug/ do utilizador, out/2026):
//   - A página de pesquisa www.lidl.pt/q/search?q=<termo> FUNCIONA num
//     browser real: "arroz" → 12 produtos; "cerveja preta" → ARGUS 2,99 €.
//   - Os produtos NÃO vêm no HTML inicial — a app "storefront" Vue carrega-os
//     via XHR/fetch. Por isso o HTTP simples não chega.
//   - O site pode pedir a seleção da loja ("Seleciona a tua loja Lidl...").
//
// ESTA VERSÃO regista TUDO no terminal (linhas com prefixo [lidl]) para
// podermos ver exactamente o que o browser vê.

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import { getContext } from '../browser.js';

const BASE = 'https://www.lidl.pt';

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'pt-PT,pt;q=0.9',
};

const MAX_RESULTS = 30;

const log = (...args) => console.log('[lidl]', ...args);

export async function searchLidl(query) {
  // ── 1) HTTP rápido (raramente tem produtos, mas é instantâneo) ────────────
  try {
    const res = await fetch(`${BASE}/q/search?q=${encodeURIComponent(query)}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    log(`HTTP tentativa: ${res.status}`);
    if (res.ok) {
      const offers = extractFromAnyJson(await res.text());
      log(`HTTP: ${offers.length} produtos no HTML`);
      if (offers.length > 0) return filterByQuery(offers, query).slice(0, MAX_RESULTS);
    }
  } catch (err) {
    log(`HTTP falhou: ${err.message}`);
  }

  // ── 2) Browser: pesquisa real + interceção de TODAS as respostas JSON ─────
  const offers = await searchViaBrowser(query);
  if (offers.length === 0) {
    throw new Error(
      `A pesquisa no lidl.pt não devolveu produtos para "${query}". ` +
      `VERIFIQUE O TERMINAL: as linhas "[lidl]" dizem o que aconteceu. ` +
      `Se o site pedir para selecionar a loja, corra uma vez com BROWSER_HEADED=true, ` +
      `escolha a loja na janela e volte a testar.`,
    );
  }
  return filterByQuery(offers, query).slice(0, MAX_RESULTS);
}

// ─── Browser com interceção de respostas JSON ───────────────────────────────

async function searchViaBrowser(query) {
  const ctx = await getContext();
  const page = await ctx.newPage();

  // Captura TODAS as respostas JSON (sem filtro de URL — o endpoint pode
  // ter um nome inesperado; filtramos pelo conteúdo depois)
  const jsonResponses = [];
  page.on('response', (res) => {
    (async () => {
      try {
        const ct = res.headers()?.['content-type'] ?? '';
        if (!ct.includes('application/json')) return;
        const json = await res.json();
        jsonResponses.push({ url: res.url(), json });
      } catch {
        // ignora
      }
    })();
  });

  try {
    const url = `${BASE}/q/search?q=${encodeURIComponent(query)}`;
    log(`browser: a abrir ${url}`);
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    log(`browser: goto HTTP ${res?.status()}`);

    // ── espera pelos resultados ──
    // 1) texto "€" (preços renderizados)
    const hasEuro = await page
      .waitForFunction(() => (document.body?.innerText ?? '').includes('€'), { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    log(`browser: texto "€" no corpo? ${hasEuro}`);

    // 2) tiles de produto visíveis (seletor conhecido do storefront)
    const hasTiles = await page
      .waitForSelector('.product-grid-box', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    log(`browser: tiles .product-grid-box visíveis? ${hasTiles}`);

    await page.waitForTimeout(1500); // deixa as XHR acabarem
    log(`browser: ${jsonResponses.length} respostas JSON capturadas`);
    for (const r of jsonResponses.slice(0, 6)) {
      log(`  · ${r.url.slice(0, 110)}`);
    }

    // deteta pedido de seleção de loja
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (/seleciona(r)? a tua loja|escolha a sua loja|selecione a (sua|tua) loja/i.test(bodyText)) {
      log('browser: o site pede a SELEÇÃO DA LOJA — escolha-a uma vez em modo headed');
    }

    // 2a) produtos vindos da API (JSON intercetado)
    const fromApi = [];
    for (const { json } of jsonResponses) {
      fromApi.push(...extractFromAnyJson(json));
    }
    log(`extração API: ${fromApi.length} produtos`);
    if (fromApi.length > 0) return dedupe(fromApi);

    // 2b) fallback: DOM renderizado
    const html = await page.content();
    const fromDom = extractFromDom(html);
    log(`extração DOM: ${fromDom.length} produtos`);
    if (fromDom.length === 0) {
      await saveDebugArtifacts(page, '(extração vazia)');
    }
    return dedupe(fromDom);
  } catch (err) {
    await saveDebugArtifacts(page, `(erro: ${err.message})`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Diagnóstico: screenshot + HTML ─────────────────────────────────────────

async function saveDebugArtifacts(page, note = '') {
  try {
    const dir = path.resolve(process.cwd(), 'debug');
    await mkdir(dir, { recursive: true });
    const stamp = `lidl-search-${Date.now()}`;
    await page.screenshot({ path: path.join(dir, `${stamp}.png`) }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(path.join(dir, `${stamp}.html`), html, 'utf8').catch(() => {});
    log(`diagnóstico: debug/${stamp}.png/.html ${note}`);
  } catch (err) {
    console.error('[lidl] FALHA ao guardar debug:', err.message);
  }
}

// ─── Extração genérica de produtos de qualquer JSON ─────────────────────────

function extractFromAnyJson(payload) {
  const offers = [];
  const seen = new Set();

  function walk(node, depth) {
    if (depth > 10 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const name = node.name ?? node.title ?? node.productName ?? node.product?.name;
    if (typeof name === 'string' && name.length > 3) {
      const priceVal =
        node.price ?? node.currentPrice ?? node.priceValue ?? node.price?.value ??
        node.product?.price;
      const price = Number(priceVal);
      if (Number.isFinite(price) && price > 0) {
        const key = `${name}|${price}`;
        if (!seen.has(key)) {
          seen.add(key);
          const old =
            node.oldPrice ?? node.wasPrice ?? node.regularPrice ?? node.price?.old;
          const unitPrice =
            node.unitPrice ?? node.pricePerUnit ?? node.basePrice ?? node.price?.perUnit;
          const unit = node.unit ?? node.baseUnit ?? node.price?.unit;
          const url =
            node.url ?? node.productUrl ?? node.slug ?? node.product?.url;

          offers.push({
            supermarket: 'Lidl',
            brand:
              (typeof node.brand === 'string' ? node.brand : node.brand?.name) ??
              guessBrand(name),
            name,
            price,
            unitPrice: Number.isFinite(Number(unitPrice)) ? Number(unitPrice) : undefined,
            unit: typeof unit === 'string' ? unit : undefined,
            promo: old ? `antes ${formatPt(old)}` : undefined,
            url: url && typeof url === 'string' ? new URL(url, BASE).href : undefined,
          });
        }
      }
    }

    for (const v of Object.values(node)) walk(v, depth + 1);
  }

  if (typeof payload === 'string') {
    offers.push(...parseJsonLdProducts(payload));
    return offers;
  }

  walk(payload, 0);
  return offers;
}

// ─── Fallback: DOM renderizado (seletores do storefront + genérico) ─────────

function extractFromDom(html) {
  const $ = cheerio.load(html);
  const offers = [];
  const seen = new Set();

  // 1) Tiles reais do storefront Vue — cada um tem data-gridbox-impression
  //    com JSON URL-encoded: {brand, name, price, id, ...}
  $('.product-grid-box').each((_, el) => {
    const $box = $(el);
    let data = {};
    const attr = $box.attr('data-gridbox-impression');
    if (attr) {
      try {
        data = JSON.parse(decodeURIComponent(attr));
      } catch {
        // atributo inválido — usa os seletores abaixo
      }
    }

    const brand =
      data.brand ||
      $box.find('.product-grid-box__brand').first().text().trim() ||
      '';
    const name = String(
      data.name ||
        $box.find('.product-grid-box__title').first().text(),
    ).replace(/\s+/g, ' ').trim();

    let price = Number(data.price);
    if (!Number.isFinite(price)) {
      const t = $box.find('.ods-price__value').first().text().replace(/\s/g, '').replace(',', '.');
      price = Number(t);
    }
    if (!name || !Number.isFinite(price) || price <= 0) return;

    // preço antigo (strike-through) → promoção
    const oldText = $box.find('s').first().text().replace(/\s/g, '').replace(',', '.');
    const oldPrice = Number(oldText);
    const promo =
      Number.isFinite(oldPrice) && oldPrice > price
        ? `antes ${formatPt(oldPrice)}`
        : undefined;

    // preço unitário: footer "Emb. 2 kg 1 kg = 0,80"
    const footer = $box.find('.ods-price__footer').first().text();
    const um = footer.match(/1\s*(kg|l|lt|un)\s*=\s*(\d+[.,]\d+)/i);

    const href = $box.find('a[href*="/p/"]').first().attr('href');

    const key = `${name}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    offers.push({
      supermarket: 'Lidl',
      brand,
      name,
      price,
      unitPrice: um ? Number(um[2].replace(',', '.')) : undefined,
      unit: um ? um[1].replace('lt', 'l') : undefined,
      promo,
      url: href ? new URL(href.split('#')[0].split('?')[0], BASE).href : undefined,
    });
  });

  if (offers.length > 0) return offers;

  // 2) fallback genérico (estrutura mudou?): seletores amplos + subida por
  //    preços — a página de pesquisa só mostra produtos, é seguro
  $('a[href*="/p/"]').each((_, el) => {
    const $link = $(el);
    const name = $link.text().replace(/\s+/g, ' ').trim();
    const href = $link.attr('href');
    if (!name || name.length < 3 || !href) return;

    let node = $link.parent();
    for (let i = 0; i < 5 && node.length; i++) {
      const text = node.text();
      const m = text.match(/(\d{1,3}[.,]\d{2})\s*€/);
      if (m && text.length < 500) {
        const price = Number(m[1].replace(',', '.'));
        const key = `${name}|${price}`;
        if (!seen.has(key)) {
          seen.add(key);
          offers.push({
            supermarket: 'Lidl',
            brand: guessBrand(name),
            name,
            price,
            url: new URL(href.split('#')[0].split('?')[0], BASE).href,
          });
        }
        return;
      }
      node = node.parent();
    }
  });

  return offers;
}

// ─── JSON-LD ────────────────────────────────────────────────────────────────

function parseJsonLdProducts(html) {
  const offers = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const nodes =
          item?.['@type'] === 'ItemList' ? item.itemListElement : [item];
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

// ─── Utilitários ────────────────────────────────────────────────────────────

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
