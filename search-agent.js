#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — product-search scenario
 *
 * The server issues a natural-language shopping challenge, e.g.:
 *   "Find and add to cart: wireless over-ear headphones with active noise
 *    cancellation in blue. Budget under $135."
 *
 * This agent uses Claude twice:
 *   1. To turn the challenge into a search query string.
 *   2. To pick the right product + variant from the result list,
 *      avoiding sponsored decoys.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY       your Anthropic API key
 *
 * Optional env vars:
 *   AGENTGAUNTLET_API_KEY   free key from agentgauntlet.ai/keys.html
 *   AGENTGAUNTLET_BASE_URL  override base URL (default: https://agentgauntlet.ai)
 *   HEADLESS                set to "false" to watch the fingerprint browser step
 */

const Anthropic    = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');

const BASE_URL = process.env.AGENTGAUNTLET_BASE_URL || 'https://agentgauntlet.ai';
const API_KEY  = process.env.AGENTGAUNTLET_API_KEY  || null;
const HEADLESS = process.env.HEADLESS !== 'false';

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
  if (!res.ok && json.action !== 'block' && json.action !== 'step_up') {
    throw new Error(`API ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function printResult(risk, outcome) {
  console.log('\n─────────────────────────────────');
  console.log('RESULT  [product-search]');
  console.log('─────────────────────────────────');
  console.log(`Outcome:    ${outcome}`);
  if (risk) {
    console.log(`Risk score: ${risk.score}/100`);
    console.log(`Tier:       ${risk.tier}`);
    console.log(`Action:     ${risk.action}`);
    if (risk.signals && risk.signals.length)
      console.log(`Signals:    ${risk.signals.join(', ')}`);
  }
  console.log('─────────────────────────────────\n');
}

// --- Fingerprint -----------------------------------------------------------

async function computeFingerprint(page) {
  return page.evaluate(async () => {
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

    let audioHash = null;
    try {
      const offline = new OfflineAudioContext(1, 4096, 44100);
      const osc     = offline.createOscillator();
      const comp    = offline.createDynamicsCompressor();
      osc.type = 'triangle'; osc.frequency.value = 10000;
      osc.connect(comp); comp.connect(offline.destination);
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
      canvasHash, audioHash,
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      screen:    { width: screen.width, height: screen.height },
      tz:        Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}

async function submitFingerprint(sessionId, token, page) {
  const fp = await computeFingerprint(page);
  console.log(`Fingerprint: canvas=${fp.canvasHash} audio=${fp.audioHash || 'null'} webdriver=${fp.webdriver}`);
  return apiPost('/api/search/fingerprint', { sessionId, token, fingerprint: fp }, token);
}

// --- Telemetry stub --------------------------------------------------------

function telemetry(extra = {}) {
  return {
    mouseMoves:           Math.floor(15 + Math.random() * 25),
    keystrokeCount:       Math.floor(8  + Math.random() * 12),
    keystrokeIntervalStd: Math.floor(30 + Math.random() * 60),
    scrollEvents:         Math.floor(2  + Math.random() * 5),
    focusBlurEvents:      Math.floor(1  + Math.random() * 3),
    mouseEntropy:         +(2.5 + Math.random()).toFixed(2),
    clickCount:           Math.floor(1  + Math.random() * 3),
    clickDwellMedian:     Math.floor(80 + Math.random() * 120),
    mouseVelocityMean:    Math.floor(250 + Math.random() * 300),
    mouseVelocityStd:     Math.floor(60  + Math.random() * 100),
    mouseCurvature:       +(0.3 + Math.random() * 0.4).toFixed(2),
    firstEventLatencyMs:  Math.floor(1200 + Math.random() * 2000),
    ...extra,
  };
}

// --- Claude helpers --------------------------------------------------------

async function askClaude(prompt) {
  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 128,
    system:     'You are a shopping agent. Answer with the minimum text required — no explanation.',
    messages:   [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text.trim();
}

async function buildQuery(challenge) {
  const raw = await askClaude(
    `Shopping challenge: "${challenge}"\n` +
    `Write a short search query (3-6 words) that captures the key product terms. Reply with ONLY the query string.`
  );
  // Strip quotes if Claude wrapped the query
  return raw.replace(/^["']|["']$/g, '').trim();
}

async function pickProduct(challenge, results) {
  // Filter out sponsored products — the agent should not need Claude for this
  const organic = results.filter(r => !r.sponsored);

  const list = organic.map((r, i) =>
    `${i}: id=${r.id} name="${r.name}" price=$${r.price} desc="${r.desc}" variants=[${r.variants.join(', ')}]`
  ).join('\n');

  const raw = await askClaude(
    `Shopping challenge: "${challenge}"\n\n` +
    `Non-sponsored search results:\n${list}\n\n` +
    `Reply with ONLY a JSON object: {"index": <number>, "variant": "<exact variant string>"}. ` +
    `Pick the result that best matches the challenge and the correct variant.`
  );

  const match = raw.match(/\{[^}]+\}/);
  if (!match) throw new Error(`Unexpected Claude response: "${raw}"`);
  const { index, variant } = JSON.parse(match[0]);
  return { product: organic[index], variant };
}

// --- Main ------------------------------------------------------------------

async function run() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [product-search]\n`);

  // 1. Start session — server returns a natural-language shopping challenge
  const session = await apiPost('/api/search/session', {}, null);
  const { sessionId, token, challenge } = session;
  console.log(`Session:   ${sessionId}`);
  console.log(`Challenge: "${challenge}"\n`);

  if (session.risk?.action === 'block') {
    printResult(session.risk, 'blocked at session start');
    return;
  }

  // 2. Fingerprint via real browser context
  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

  const fpResult = await submitFingerprint(sessionId, token, page);
  await browser.close();

  if (fpResult.action === 'block') {
    printResult(fpResult.risk, 'blocked at fingerprint');
    return;
  }

  // 3. Build a search query from the challenge text
  const query = await buildQuery(challenge);
  console.log(`Query:     "${query}"`);

  // Pause to simulate reading the challenge
  await new Promise(r => setTimeout(r, Math.floor(1500 + Math.random() * 1500)));

  const queryResult = await apiPost('/api/search/query', {
    sessionId, token, query,
    telemetry: telemetry({ keystrokeCount: query.length }),
  }, token);

  if (!queryResult.ok) {
    printResult(queryResult.risk, queryResult.action || 'blocked at query');
    return;
  }

  const sponsored = queryResult.results.filter(r => r.sponsored).map(r => r.name);
  console.log(`Results:   ${queryResult.resultCount} products` +
    (sponsored.length ? ` (sponsored decoys: ${sponsored.join(', ')})` : ''));

  // 4. Pick the right product + variant, ignoring sponsored results
  const { product, variant } = await pickProduct(challenge, queryResult.results);
  console.log(`Selected:  "${product.name}" — variant: "${variant}"`);

  // Pause to simulate reading results before adding to cart
  await new Promise(r => setTimeout(r, Math.floor(1500 + Math.random() * 2000)));

  // 5. Add to cart
  const addResult = await apiPost('/api/search/add', {
    sessionId, token,
    productId: product.id,
    variant,
    telemetry: telemetry({ clickCount: 2 }),
  }, token);

  const outcome = addResult.ok ? 'completed' : (addResult.action || 'blocked');
  printResult(addResult.risk, outcome);
  if (addResult.orderId) console.log(`Order ID:  ${addResult.orderId}`);
}

run().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
