#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — payment-checkout scenario
 *
 * Card entry + authorization challenge. The server detects bot-like
 * patterns across two steps:
 *
 * Step 1 — card entry:
 *   honeypot_filled          — honeypotCardBackup field was set
 *   wrong_item_step1         — incorrect card number or Luhn check failed
 *   wrong_shipping_step2     — incorrect expiry month/year or CVV
 *   coupon_no_keystrokes     — card/CVV reported as pasted, or too few keystrokes
 *   uniform_keystroke_timing — cardGroupPauses std/mean < 0.1 (robot-uniform gaps)
 *
 * Step 2 — authorization:
 *   clicked_recommended_decoy — clicked decoy button instead of real one
 *   too_fast                  — total elapsed < 4s
 *   low_mouse_activity        — mouseMoves < 10
 *   superhuman_reaction_time  — firstEventLatencyMs < 100ms
 *
 * Required env vars:
 *   (none — no vision required)
 *
 * Optional env vars:
 *   AGENTGAUNTLET_API_KEY   free key from agentgauntlet.ai/keys.html
 *   AGENTGAUNTLET_BASE_URL  override base URL (default: https://agentgauntlet.ai)
 *   HEADLESS                set to "false" to watch the fingerprint browser step
 */

const { chromium } = require('playwright');

const BASE_URL = process.env.AGENTGAUNTLET_BASE_URL || 'https://agentgauntlet.ai';
const API_KEY  = process.env.AGENTGAUNTLET_API_KEY  || null;
const HEADLESS = process.env.HEADLESS !== 'false';

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

function printResult(risk, outcome) {
  console.log('\n─────────────────────────────────');
  console.log('RESULT  [payment-checkout]');
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
  return apiPost('/api/payment/fingerprint', { sessionId, token, fingerprint: fp }, token);
}

// --- Telemetry helpers -----------------------------------------------------

function baseTelemetry() {
  return {
    mouseMoves:          Math.floor(15 + Math.random() * 20),
    clickCount:          Math.floor(2  + Math.random() * 3),
    clickDwellMedian:    Math.floor(90 + Math.random() * 120),
    mouseVelocityMean:   Math.floor(230 + Math.random() * 270),
    mouseVelocityStd:    Math.floor(60  + Math.random() * 90),
    mouseEntropy:        +(0.5 + Math.random() * 0.4).toFixed(2),
    scrollEvents:        Math.floor(2  + Math.random() * 4),
    firstEventLatencyMs: Math.floor(300 + Math.random() * 800),
  };
}

// Generate varied inter-group pauses for a card number typed in groups of 4.
// A 16-digit card has 3 gaps (after groups 1, 2, 3). Pauses must have
// std/mean >= 0.1 to avoid uniform_keystroke_timing.
function cardGroupPauses() {
  // Anchor values spread across a wide range to guarantee high variance
  const base = [250, 480, 170, 620].slice(0, 3);
  return base.map(b => b + Math.floor(Math.random() * 120 - 60));
}

// --- Main ------------------------------------------------------------------

async function run() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [payment-checkout]\n`);

  const sessionStart = Date.now();

  // 1. Start session
  const session = await apiPost('/api/payment/session', {}, null);
  const { sessionId, token, card } = session;

  console.log(`Session:  ${sessionId}`);
  console.log(`Card:     ${card.number}  exp ${card.expMonth}/${card.expYear}  cvv ${card.cvv}\n`);

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

  // 3. Simulate reading the payment form before typing
  const readDelay = Math.floor(2000 + Math.random() * 2000);
  console.log(`Reading payment form for ${Math.round(readDelay / 1000)}s…`);
  await sleep(readDelay);

  // Simulate typing the card number in 4-digit groups with natural pauses
  const pauses = cardGroupPauses();
  console.log(`Typing card number (group pauses: ${pauses.join(', ')}ms)…`);
  for (const pause of pauses) {
    await sleep(Math.floor(4 * 110 + Math.random() * 200)); // type one group
    await sleep(pause);                                      // pause between groups
  }
  await sleep(Math.floor(4 * 110 + Math.random() * 200));   // last group

  console.log('Typing expiry and CVV…');
  await sleep(Math.floor(500 + Math.random() * 500));

  // 4. Submit step 1 — correct card data, no honeypot, typed not pasted
  const step1Result = await apiPost('/api/payment/step1', {
    sessionId, token,
    card: {
      number:            card.number,
      expMonth:          card.expMonth,
      expYear:           card.expYear,
      cvv:               card.cvv,
      honeypotCardBackup: '',   // leave empty — it's a trap
    },
    telemetry: {
      ...baseTelemetry(),
      cardGroupPauses:     pauses,
      cardKeystrokes:      card.number.length,   // 16 digits
      cvvKeystrokes:       card.cvv.length,       // 3 digits
      cardPastedNotTyped:  false,
      cvvPastedNotTyped:   false,
    },
  }, token);

  if (!step1Result.ok) {
    printResult(step1Result.risk, step1Result.action || 'blocked at step 1');
    return;
  }

  console.log(`Step 1 passed — real button: ${step1Result.realBtnId}  decoy: ${step1Result.decoyBtnId}`);

  // 5. Simulate reviewing the order summary before confirming
  const reviewDelay = Math.floor(2000 + Math.random() * 2000);
  console.log(`Reviewing order for ${Math.round(reviewDelay / 1000)}s…`);
  await sleep(reviewDelay);

  // Ensure at least 4s total have elapsed (too_fast gate)
  const elapsed = Date.now() - sessionStart;
  if (elapsed < 4500) {
    await sleep(4500 - elapsed);
  }

  // 6. Authorize — click the real button, not the decoy
  console.log(`Authorizing with button ${step1Result.realBtnId}…`);
  const authResult = await apiPost('/api/payment/authorize', {
    sessionId, token,
    clickedBtnId: step1Result.realBtnId,
    telemetry: baseTelemetry(),
  }, token);

  const outcome = authResult.ok
    ? (authResult.action || 'completed')
    : (authResult.action || 'blocked');

  printResult(authResult.risk, outcome);
  if (authResult.confirmationId)
    console.log(`Confirmation: ${authResult.confirmationId}`);
}

run().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
