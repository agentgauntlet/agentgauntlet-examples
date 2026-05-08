#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — cart-checkout scenario
 *
 * Supports two modes:
 *   cv       (default) — agent screenshots the page and uses Claude vision to
 *                        extract item/price information. No structured data from API.
 *   headless           — agent receives structured JSON from the API and resolves
 *                        answers without needing to read the page visually.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY       your Anthropic API key
 *
 * Optional env vars:
 *   AGENT_MODE              "cv" (default) or "headless"
 *   AGENTGAUNTLET_API_KEY   free key from agentgauntlet.ai/keys.html (unlocks leaderboard)
 *   AGENTGAUNTLET_BASE_URL  override base URL (default: https://agentgauntlet.ai)
 *   HEADLESS                set to "false" to watch the browser (default: true)
 */

const Anthropic    = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');

const BASE_URL   = process.env.AGENTGAUNTLET_BASE_URL || 'https://agentgauntlet.ai';
const API_KEY    = process.env.AGENTGAUNTLET_API_KEY  || null;
const HEADLESS   = process.env.HEADLESS !== 'false';
const AGENT_MODE = process.env.AGENT_MODE === 'headless' ? 'headless' : 'cv';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- API helpers -----------------------------------------------------------

async function apiPost(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;
  if (token)   headers['X-Session-Token'] = token;
  const res  = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`API ${path} → ${res.status} (non-JSON):\n${text.slice(0, 300)}`); }
  if (!res.ok && !json.ok && json.action !== 'block' && json.action !== 'step_up') {
    throw new Error(`API ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function printResult(risk, outcome, mode) {
  console.log('\n─────────────────────────────────');
  console.log(`RESULT  [mode: ${mode}]`);
  console.log('─────────────────────────────────');
  console.log(`Outcome:    ${outcome || (risk && risk.action) || 'unknown'}`);
  if (risk) {
    console.log(`Risk score: ${risk.score}/100`);
    console.log(`Tier:       ${risk.tier}`);
    console.log(`Action:     ${risk.action}`);
    if (risk.signals && risk.signals.length)
      console.log(`Signals:    ${risk.signals.join(', ')}`);
    if (risk.breakdown && risk.breakdown.length) {
      console.log('\nBreakdown:');
      risk.breakdown.forEach(d => console.log(`  ${d.dimension}: ${d.score}`));
    }
  }
  console.log('─────────────────────────────────\n');
}

// --- Claude vision helper --------------------------------------------------

async function askClaude(screenshotBuf, task) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    system: 'You are a web agent. Reply with the shortest possible answer — a single word or short phrase. No explanation, no calculations, no markdown.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBuf.toString('base64') } },
        { type: 'text', text: task },
      ],
    }],
  });
  // Strip markdown bold markers and take the last non-empty line in case
  // Claude still includes reasoning before the final answer.
  const raw = msg.content[0].text.trim();
  const clean = raw.replace(/\*\*/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  return clean[clean.length - 1] || raw;
}

// --- Telemetry stub (honest — no mouse data) --------------------------------

function telemetry() {
  return { mouseEvents: [], keyEvents: [], scrollEvents: [], dwellMs: Math.floor(800 + Math.random() * 1200) };
}

// --- Fingerprint — computed from real browser context ----------------------

// --- Fingerprint — computed from real browser context ----------------------

async function computeFingerprint(page) {
  return page.evaluate(async () => {
    // Canvas fingerprint
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.font = '11pt Arial';
    ctx.fillText('AgentGauntlet 🚀', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.font = '18pt Arial';
    ctx.fillText('AgentGauntlet 🚀', 4, 45);
    const raw = canvas.toDataURL();
    let h = 0;
    for (let i = 0; i < raw.length; i++) { h = Math.imul(31, h) + raw.charCodeAt(i) | 0; }
    const canvasHash = (h >>> 0).toString(16).padStart(8, '0');

    // Audio fingerprint — use OfflineAudioContext which works in headless
    let audioHash = null;
    try {
      const offline = new OfflineAudioContext(1, 4096, 44100);
      const osc     = offline.createOscillator();
      const comp    = offline.createDynamicsCompressor();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      osc.connect(comp);
      comp.connect(offline.destination);
      osc.start(0);
      const rendered = await offline.startRendering();
      const buf = rendered.getChannelData(0);
      let ah = 0;
      for (let i = 0; i < Math.min(buf.length, 500); i++) {
        ah = Math.imul(31, ah) + Math.round(buf[i] * 1e8) | 0;
      }
      audioHash = (ah >>> 0).toString(16).padStart(8, '0');
    } catch (_) {}

    return {
      canvasHash,
      audioHash,
      webdriver:  navigator.webdriver,
      userAgent:  navigator.userAgent,
      screen:     { width: screen.width, height: screen.height },
      tz:         Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}

async function submitFingerprint(sessionId, token, page) {
  const fingerprint = await computeFingerprint(page);
  console.log(`Fingerprint: canvas=${fingerprint.canvasHash} audio=${fingerprint.audioHash || 'null'} webdriver=${fingerprint.webdriver}`);
  return apiPost('/api/v2/fingerprint', { sessionId, token, fingerprint }, token);
}

// ===========================================================================
// CV MODE — agent reads the page visually, submits answers by name
// ===========================================================================

async function runCv() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [CV mode]\n`);

  // 1. Start CV session — server returns tasks + scenarioUrl, no item data
  const session = await apiPost('/api/v2/session', { mode: 'cv' }, null);
  const { sessionId, token, tasks, scenarioUrl } = session;
  console.log(`Session: ${sessionId}`);
  console.log(`Scenario URL: ${scenarioUrl}\n`);

  // 2. Launch browser — add webdriver override before first navigation
  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(scenarioUrl, { waitUntil: 'networkidle' });
  console.log('Browser opened:', scenarioUrl);

  // 3. Compute and submit fingerprint from the real browser context
  const fpResult = await submitFingerprint(sessionId, token, page);
  if (fpResult.action === 'block') {
    await browser.close();
    console.log('Blocked at fingerprint stage.');
    printResult(fpResult.risk, 'blocked', 'cv');
    return;
  }

  // --- Step 1: identify item visually, then click it on the page ----------
  // The page advances its own UI when items are clicked; it also submits
  // each step to the server. The agent only reads visually and clicks.
  await page.waitForSelector('#cart-items li', { timeout: 15000 }).catch(async () => {
    const statusText = await page.$eval('#status', el => el.textContent).catch(() => '(unknown)');
    await browser.close();
    throw new Error(`Cart never rendered. Page status: "${statusText}" — session lost to server restart, re-run.`);
  });
  const shot1 = await page.screenshot({ fullPage: true });
  console.log(`\nStep 1 task: ${tasks.step1}`);

  const itemAnswer = await askClaude(shot1,
    `${tasks.step1}\nLook at the cart items shown on the page. Reply with ONLY the exact product name of the matching item.`
  );
  console.log(`Claude identified: "${itemAnswer}"`);

  // Click the item on the page — page submits step 1 to the server
  const itemLoc = page.locator('[data-item-id]').filter({ hasText: itemAnswer }).first();
  await itemLoc.click();

  // --- Step 2: wait for shipping options, identify visually, click ---------
  await page.waitForSelector('section[data-step="2"]:not([hidden])', { timeout: 10000 });
  const shot2 = await page.screenshot({ fullPage: true });
  console.log(`\nStep 2 task: ${tasks.step2}`);

  const shippingAnswer = await askClaude(shot2,
    `${tasks.step2}\nLook at the shipping option cards on the page. Reply with ONLY the option name (one word, e.g. Standard or Express or Overnight). Do not explain.`
  );
  console.log(`Claude identified: "${shippingAnswer}"`);

  // Click the shipping option on the page — page submits step 2 to the server
  const shippingLoc = page.locator('#shipping-options').getByText(shippingAnswer, { exact: false }).first();
  await shippingLoc.click();

  // --- Step 3: wait for checkout buttons (or terminal block card) -----------
  await page.waitForSelector(
    'section[data-step="3"]:not([hidden]), h2.text-red-700, h2.text-green-700',
    { timeout: 10000 },
  );
  const isBlockedAtStep2 = await page.$('h2.text-red-700') !== null;
  if (isBlockedAtStep2) {
    await browser.close();
    printResult(null, 'blocked at step 2', 'cv');
    return;
  }
  const shot3 = await page.screenshot({ fullPage: true });
  console.log(`\nStep 3 task: ${tasks.step3}`);

  const btnAnswer = await askClaude(shot3,
    `${tasks.step3}\nLook at the checkout buttons on the page. One is marked "Recommended". Reply with ONLY the exact label text of the OTHER button (the one NOT marked Recommended). No explanation.`
  );
  console.log(`Claude identified non-recommended button: "${btnAnswer}"`);

  // Click the non-recommended button on the page
  const btnLoc = page.locator('#step3-buttons button').filter({ hasText: btnAnswer }).first();
  await btnLoc.click();

  // Wait for the terminal card (success or block) then read the risk badge
  await page.waitForSelector('h2.text-green-700, h2.text-red-700', { timeout: 10000 }).catch(() => {});
  const checkoutResult = await page.evaluate(() => {
    const score  = parseInt(document.getElementById('risk-score')?.textContent) || null;
    const tier   = document.getElementById('risk-tier')?.textContent?.trim() || null;
    const isBlock = !!document.querySelector('h2.text-red-700');
    return { score, tier, isBlock };
  });
  const riskResult = { score: checkoutResult.score, tier: checkoutResult.tier, action: checkoutResult.isBlock ? 'block' : 'allow' };
  const outcome = checkoutResult.isBlock ? 'blocked' : 'completed';

  await browser.close();
  printResult(riskResult, outcome, 'cv');
}

// ===========================================================================
// HEADLESS MODE — agent receives structured JSON, no vision needed
// ===========================================================================

async function runHeadless() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [headless mode]\n`);

  // 1. Start headless session — server returns cart items + price ranges
  const session = await apiPost('/api/v2/session', {}, null);
  const { sessionId, token, cart, subtotal, step1: step1Meta } = session;
  console.log(`Session: ${sessionId}`);
  console.log(`Cart has ${cart.length} items, subtotal $${subtotal}`);
  console.log(`Step 1 prompt: ${step1Meta.prompt}\n`);

  // 2. Launch browser briefly to compute real fingerprint values
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(`${BASE_URL}/v2`, { waitUntil: 'networkidle' });
  const fpResult = await submitFingerprint(sessionId, token, page);
  await browser.close();
  if (fpResult.action === 'block') {
    console.log('Blocked at fingerprint stage.');
    printResult(fpResult.risk, 'blocked', 'headless');
    return;
  }

  // --- Step 1: find item in price range from structured data ---------------
  const targetItem = cart.find(i => i.unitPrice >= step1Meta.low && i.unitPrice <= step1Meta.high);
  if (!targetItem) throw new Error('No item found in step 1 price range');
  console.log(`Step 1 → selecting: ${targetItem.name} ($${targetItem.unitPrice})`);

  const step1Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 1,
    answer: { itemId: targetItem.id, clickedDecoy: false },
    telemetry: telemetry(),
  }, token);
  if (step1Result.action === 'block') {
    printResult(step1Result.risk, 'blocked at step 1', 'headless');
    return;
  }

  // --- Step 2: find shipping in pct range from structured data -------------
  const { shipping, step2: step2Meta } = step1Result;
  console.log(`Step 2 prompt: ${step2Meta.prompt}`);

  const targetShipping = shipping.find(s => {
    const pct = (s.cost / subtotal) * 100;
    return pct >= step2Meta.lowPct && pct <= step2Meta.highPct;
  });
  if (!targetShipping) throw new Error('No shipping found in step 2 pct range');
  console.log(`Step 2 → selecting: ${targetShipping.name} ($${targetShipping.cost})`);

  const step2Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 2,
    answer: { shippingId: targetShipping.id },
    telemetry: telemetry(),
  }, token);
  if (step2Result.action === 'block') {
    printResult(step2Result.risk, 'blocked at step 2', 'headless');
    return;
  }

  // --- Step 3: click real button using ID from API -------------------------
  const { step3: step3Meta, summary } = step2Result;
  console.log(`\nOrder summary: $${summary.subtotal} + ${summary.shippingName} $${summary.shippingCost} + tax $${summary.tax} = $${summary.total}`);
  console.log('Step 3 → clicking real button (non-recommended)');

  const checkoutResult = await apiPost('/api/v2/checkout', {
    sessionId, token,
    clickedBtnId: step3Meta.realBtnId,
    telemetry: telemetry(),
  }, token);

  printResult(checkoutResult.risk, checkoutResult.outcome || 'completed', 'headless');
}

// --- Entry point -----------------------------------------------------------

const runner = AGENT_MODE === 'headless' ? runHeadless : runCv;
runner().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
