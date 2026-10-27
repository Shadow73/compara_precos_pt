// Helper partilhado: instância única de browser Playwright (Chromium headless)
// reutilizada entre pesquisas.
//
// PERFIL PERSISTENTE (browser-profile/ na raiz do projeto): os cookies e o
// estado de consentimento ficam guardados entre execuções. Isto é essencial
// para sites com anti-bot:
//   - Continente (Cookiebot): o banner de cookies deixa de aparecer
//   - Intermarché (DataDome/captcha): após resolver o captcha UMA vez em
//     modo visível, o cookie fica guardado e as pesquisas seguintes passam
//
// Opções de ambiente:
//   BROWSER_HEADED=true — corre o Chromium com janela visível (use uma vez
//                         para resolver o captcha do Intermarché; depois
//                         pode voltar a headless)
//
// Diagnóstico: passe debugName a fetchRendered — grava screenshot + HTML
// em debug/<nome>-<timestamp>.{png,html}.

import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';

let context = null; // BrowserContext persistente (BrowserContext direto)

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Botões comuns de aceitação de cookies (OneTrust, Didomi, Cookiebot, etc.)
const COOKIE_ACCEPTORS = [
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Continente
  '#onetrust-accept-btn-handler',
  '#didomi-notice-agree-button',
  'button:has-text("Aceitar todos")',
  'button:has-text("Permitir todos")',
  'button:has-text("Aceitar")',
  'button:has-text("Accept")',
];

const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const PROFILE_DIR = path.resolve(process.cwd(), 'browser-profile');

// Páginas de desafio anti-bot (Cloudflare, DataDome, PerimeterX…)
const CHALLENGE_RE =
  /just a moment|checking your browser|verify you are human|attention required|cloudflare|temporariamente restrito|captcha-delivery|datadome/i;

// Carrega o Chromium — stealth (playwright-extra) SÓ quando USE_STEALTH=true
// (desenvolvimento local, ex.: Intermarché). Em produção usa-se o playwright
// simples, garantindo correspondência com a imagem Docker e o browser embutido.
let chromiumPromise = null;
function loadChromium() {
  if (!chromiumPromise) {
    chromiumPromise = (async () => {
      if (process.env.USE_STEALTH === 'true') {
        try {
          const mod = await import('playwright-extra');
          const stealthMod = await import('puppeteer-extra-plugin-stealth');
          mod.chromium.use(stealthMod.default());
          console.log('[browser] playwright-extra + stealth ativo');
          return mod.chromium;
        } catch {
          console.log('[browser] stealth pedido mas pacotes em falta — playwright simples');
        }
      }
      const { chromium } = await import('playwright');
      return chromium;
    })();
  }
  return chromiumPromise;
}

export async function getContext() {
  if (context) return context;

  const chromium = await loadChromium();
  const launchOptions = {
    headless: process.env.BROWSER_HEADED === 'true' ? false : true,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: USER_AGENT,
    locale: 'pt-PT',
    timezoneId: 'Europe/Lisbon',
    viewport: { width: 1366, height: 900 },
  };

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  } catch (err) {
    // "A abrir numa sessão existente do navegador" — ficou um SingletonLock
    // de uma sessão anterior mal terminada (ex.: servidor morto à força).
    // Removemos os ficheiros de trinco e tentamos mais uma vez.
    console.warn('[browser] lançamento falhou, a limpar trinco do perfil e a repetir...');
    try {
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        await rm(path.join(PROFILE_DIR, f), { force: true });
      }
      context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
    } catch (err2) {
      throw new Error(
        `Não foi possível abrir o browser (perfil bloqueado ou processo zombie). ` +
        `Solução: 1) pkill -f ms-playwright 2) rm -rf browser-profile 3) reinicie o servidor. ` +
        `Erro: ${err2.message}`,
      );
    }
  }

  context.on('close', () => {
    context = null;
  });
  return context;
}

async function saveDebugArtifacts(page, debugName, note = '') {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const stamp = `${debugName}-${Date.now()}`;
    const png = path.join(DEBUG_DIR, `${stamp}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${stamp}.html`);
    await page.screenshot({ path: png, fullPage: false }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(htmlPath, html, 'utf8').catch(() => {});
    return `debug/${stamp}.png (+ .html)${note ? ` — ${note}` : ''}`;
  } catch {
    return null;
  }
}

/**
 * Navega até `url` num browser real e devolve { html, title, finalUrl, debugPath }.
 */
export async function fetchRendered(
  url,
  { waitSelector, waitForText, acceptCookies = false, debugName, timeout = 25000, challengeTimeoutMs, waitUntil = 'networkidle' } = {},
) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    let res;
    try {
      res = await page.goto(url, { waitUntil, timeout });
    } catch (err) {
      if (debugName) {
        const dbg = await saveDebugArtifacts(page, debugName, `falha na navegação: ${err.message}`);
        if (dbg) err.message += ` | diagnóstico: ${dbg}`;
      }
      throw err;
    }
    if (!res?.ok()) {
      const err = new Error(`HTTP ${res?.status() ?? 'sem resposta'}`);
      if (debugName) {
        const dbg = await saveDebugArtifacts(page, debugName, err.message);
        if (dbg) err.message += ` | diagnóstico: ${dbg}`;
      }
      throw err;
    }

    if (acceptCookies) {
      for (const sel of COOKIE_ACCEPTORS) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1500 })) {
            await btn.click({ timeout: 2000 });
            break;
          }
        } catch {
          // seletor não existe neste site — tenta o seguinte
        }
      }
    }

    // ── Espera por desafios anti-bot (Cloudflare/DataDome "Just a moment…") ──
    const isChallenge = () =>
      page.evaluate(() => {
        const t = (document.body?.innerText ?? '').trim();
        return t.length < 600 && /just a moment|checking your browser|verify you are human|attention required|cloudflare|temporariamente restrito|captcha-delivery|datadome/i.test(t);
      });

    try {
      if (await isChallenge()) {
        const headed = process.env.BROWSER_HEADED === 'true';
        // Em modo visível, dá tempo de resolver o CAPTCHA manualmente
        // (DataDome/Cloudflare às vezes exige intervenção humana).
        const maxMs = challengeTimeoutMs ?? (headed ? 150000 : 20000);
        const stepMs = 2000;
        let waited = 0;
        let reloaded = false;
        while (await isChallenge()) {
          if (headed && waited === 0) {
            console.log(
              `[browser] Anti-bot detectado em ${url} — se aparecer um CAPTCHA, ` +
              `resolva-o na janela do browser (a aguardar até ${maxMs / 1000}s)...`,
            );
          }
          await page.waitForTimeout(stepMs);
          waited += stepMs;
          if (!reloaded && waited >= maxMs / 2) {
            reloaded = true;
            await page.reload({ waitUntil }).catch(() => {});
          }
          if (waited >= maxMs) break;
        }
        if (headed && waited > 0) {
          console.log('[browser] Desafio anti-bot resolvido (ou tempo esgotado).');
        }
      }
    } catch {
      // se a avaliação falhar, prossegue na mesma
    }

    if (waitSelector) {
      try {
        await page.waitForSelector(waitSelector, { timeout: 10000 });
      } catch (err) {
        if (debugName) {
          const dbg = await saveDebugArtifacts(page, debugName, `seletor não apareceu: ${waitSelector}`);
          if (dbg) err.message += ` | diagnóstico: ${dbg}`;
        }
        throw err;
      }
    } else {
      await page.waitForTimeout(1000);
    }

    if (waitForText) {
      try {
        await page.waitForFunction(
          (t) => document.body?.innerText?.includes(t),
          waitForText,
          { timeout: 10000 },
        );
      } catch (err) {
        if (debugName) {
          const dbg = await saveDebugArtifacts(page, debugName, `texto não apareceu: ${waitForText}`);
          if (dbg) err.message += ` | diagnóstico: ${dbg}`;
        }
        throw err;
      }
    }

    const debugPath = debugName ? await saveDebugArtifacts(page, debugName) : null;
    return {
      html: await page.content(),
      title: await page.title(),
      finalUrl: page.url(),
      debugPath,
    };
  } finally {
    await page.close().catch(() => {});
  }
}


/**
 * Injeta cookies no contexto persistente (ex.: o cookie "datadome" copiado
 * de um browser real, para ultrapassar o anti-bot do Intermarché).
 * `cookies`: [{ name, value, domain }] — domain com ponto inicial cobre
 * todos os subdomínios (ex.: ".intermarche.pt").
 */
export async function injectCookies(cookies) {
  if (!cookies?.length) return;
  const ctx = await getContext();
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 dias
  await ctx.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: '/',
      expires,
    })),
  );
}

/** Chamado no shutdown do processo para não deixar o browser pendurado. */
export async function closeBrowser() {
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
}
