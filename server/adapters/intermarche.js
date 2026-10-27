// Adapter: Intermarché (intermarche.pt) — estilo Lidl
//
// MESMA LÓGICA DO LIDL: browser abre a página de pesquisa, intercetamos os
// JSON da API e extraímos do DOM renderizado.
//
// DIFERENÇA CRÍTICA: o Intermarché tem DataDome, que pode bloquear o browser
// à entrada («O acesso está temporariamente restrito»). Por isso:
//   1) Injeta o cookie "datadome" copiado do teu browser (ficheiro
//      datadome-cookie.txt na raiz do projeto, ou DATADOME_COOKIE no .env)
//   2) Usa o perfil persistente + stealth (browser.js) — resolve o captcha
//      UMA vez em modo headed e o cookie fica guardado
//
// Se mesmo assim bloquear, o debug/ (screenshot + HTML) mostra o estado.

import { mkdir, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { getContext, injectCookies } from '../browser.js';

const BASE = 'https://www.intermarche.pt';
const MAX_RESULTS = 30;
const log = (...args) => console.log('[intermarche]', ...args);

export async function searchIntermarche(query) {
  // 0) Injeta o cookie datadome (se existir) ANTES de qualquer navegação
  const hasCookie = await injectDatadomeCookie();

  // 1) HTTP rápido (raramente passa no DataDome, mas é instantâneo)
  try {
    const res = await fetch(`${BASE}/pt/pesquisa?q=${encodeURIComponent(query)}`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'accept-language': 'pt-PT,pt;q=0.9',
      },
      signal: AbortSignal.timeout(6000),
    });
    log(`HTTP: ${res.status}${hasCookie ? ' (com cookie)' : ''}`);
    if (res.ok) {
      const offers = extractFromAnyJson(await res.text());
      if (offers.length > 0) return filterByQuery(offers, query).slice(0, MAX_RESULTS);
    }
  } catch (err) {
    log(`HTTP falhou: ${err.message}`);
  }

  // 2) Browser (estilo Lidl)
  const offers = await searchViaBrowser(query);
  if (offers.length === 0) {
    throw new Error(
      `DataDome continua a bloquear o acesso${hasCookie ? ' (cookie injetado)' : ' (sem cookie — crie datadome-cookie.txt)'}. ` +
      `Tente: 1) valor fresco do cookie "datadome" em datadome-cookie.txt ` +
      `2) BROWSER_HEADED=true e resolva o captcha uma vez na janela ` +
      `3) envie debug/intermarche-*.png se persistir.`,
    );
  }
  return filterByQuery(offers, query).slice(0, MAX_RESULTS);
}

// ─── Cookie datadome ────────────────────────────────────────────────────────

async function injectDatadomeCookie() {
  let value = (process.env.DATADOME_COOKIE ?? '').trim();
  if (!value) {
    try {
      value = readFileSync('datadome-cookie.txt', 'utf8').trim();
    } catch {
      // sem ficheiro — segue sem cookie
    }
  }
  if (!value) return false;
  try {
    await injectCookies([{ name: 'datadome', value, domain: '.intermarche.pt' }]);
    log('cookie datadome injetado');
    return true;
  } catch {
    return false;
  }
}

// ─── Browser ────────────────────────────────────────────────────────────────

async function searchViaBrowser(query) {
  const ctx = await getContext();
  const page = await ctx.newPage();

  const jsonResponses = [];
  page.on('response', (res) => {
    (async () => {
      try {
        const ct = res.headers()?.['content-type'] ?? '';
        if (!ct.includes('application/json')) return;
        jsonResponses.push({ url: res.url(), json: await res.json() });
      } catch {
        // ignora
      }
    })();
  });

  try {
    const url = `${BASE}/pt/pesquisa?q=${encodeURIComponent(query)}`;
    log(`browser: a abrir ${url}`);
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    log(`browser: goto HTTP ${res?.status()}`);

    const hasEuro = await page
      .waitForFunction(() => (document.body?.innerText ?? '').includes('€'), { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    log(`browser: texto "€" no corpo? ${hasEuro}`);
    await page.waitForTimeout(1500);

    // deteta bloqueio do DataDome
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const blocked = /temporariamente restrito|captcha-delivery|just a moment/i.test(bodyText);
    log(`browser: bloqueado pelo DataDome? ${blocked}`);

    log(`browser: ${jsonResponses.length} respostas JSON capturadas`);

    // 2a) API (JSON intercetado)
    const fromApi = [];
    for (const { json } of jsonResponses) fromApi.push(...extractFromAnyJson(json));
    log(`extração API: ${fromApi.length} produtos`);
    if (fromApi.length > 0) return dedupe(fromApi);

    // 2b) DOM renderizado
    const html = await page.content();
    const fromDom = extractFromDom(html);
    log(`extração DOM: ${fromDom.length} produtos`);
    if (fromDom.length === 0) await saveDebug(page, blocked ? '(DataDome)' : '(extração vazia)');
    return dedupe(fromDom);
  } catch (err) {
    await saveDebug(page, `(erro: ${err.message})`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Extração genérica de qualquer JSON ─────────────────────────────────────

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

    const name = node.name ?? node.title ?? node.productName ?? node.designation;
    if (typeof name === 'string' && name.length > 3) {
      const priceVal = node.price ?? node.currentPrice ?? node.priceValue ??
        node.price?.value ?? node.unitPrice;
      const price = Number(priceVal);
      if (Number.isFinite(price) && price > 0) {
        const key = `${name}|${price}`;
        if (!seen.has(key)) {
          seen.add(key);
          const old = node.oldPrice ?? node.wasPrice ?? node.regularPrice;
          const url = node.url ?? node.productUrl ?? node.slug;
          offers.push({
            supermarket: 'Intermarché',
            brand: (typeof node.brand === 'string' ? node.brand : node.brand?.name) ?? '',
            name,
            price,
            promo: old ? `antes ${formatPt(old)}` : undefined,
            url: url && typeof url === 'string' ? new URL(url, BASE).href : undefined,
          });
        }
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  }

  if (typeof payload === 'string') return offers; // HTML tratado no DOM
  walk(payload, 0);
  return offers;
}

// ─── DOM genérico (seletores a confirmar com o debug) ───────────────────────

function extractFromDom(html) {
  const $ = cheerio.load(html);
  const offers = [];
  const seen = new Set();

  // 1) contentores com classe "product" que contenham preço
  $('[class*="product"], [class*="tile"], [data-testid*="product"]').each((_, el) => {
    const $el = $(el);
    const text = $el.text();
    if (text.length > 600) return;
    const name = $el.find('h2, h3, [class*="name"], [class*="title"], a').first()
      .text().replace(/\s+/g, ' ').trim();
    const m = text.match(/(\d{1,3}[.,]\d{2})\s*€/);
    if (!name || name.length < 3 || !m) return;
    const price = Number(m[1].replace(',', '.'));
    const href = $el.find('a[href]').first().attr('href');
    const key = `${name}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);
    offers.push({
      supermarket: 'Intermarché',
      brand: '',
      name,
      price,
      url: href ? new URL(href, BASE).href : undefined,
    });
  });

  // 2) links de produto com preço nas proximidades
  if (offers.length === 0) {
    $('a[href*="produto"], a[href*="product"]').each((_, el) => {
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
              supermarket: 'Intermarché',
              brand: '',
              name,
              price,
              url: new URL(href.split('#')[0], BASE).href,
            });
          }
          return;
        }
        node = node.parent();
      }
    });
  }

  return offers;
}

// ─── Debug ──────────────────────────────────────────────────────────────────

async function saveDebug(page, note = '') {
  try {
    const dir = path.resolve(process.cwd(), 'debug');
    await mkdir(dir, { recursive: true });
    const stamp = `intermarche-${Date.now()}`;
    await page.screenshot({ path: path.join(dir, `${stamp}.png`) }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(path.join(dir, `${stamp}.html`), html, 'utf8').catch(() => {});
    log(`diagnóstico: debug/${stamp}.png/.html ${note}`);
  } catch (err) {
    console.error('[intermarche] falha ao guardar debug:', err.message);
  }
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
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function formatPt(v) {
  return `${Number(v).toFixed(2).replace('.', ',')} €`;
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
