#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — bank-login scenario
 *
 * Credential-stuffing + OTP step-up challenge. The server detects bot-like
 * patterns across two steps:
 *
 * Step 1 — credential entry:
 *   honeypot_filled          — honeypotUsernameConfirm field was set, or trap checkbox ticked
 *   clicked_recommended_decoy — panelId was the SSO decoy panel, not the real one
 *   wrong_item_step1         — incorrect username or password submitted
 *   coupon_no_keystrokes     — password/username reported as pasted, or < 4 keystrokes
 *   uniform_keystroke_timing — keystrokeIntervalStd < 15ms (robot-perfect timing)
 *
 * Step 2 — OTP:
 *   wrong_item_step1         — wrong OTP code
 *   too_fast                 — total elapsed < 5s from session start
 *   low_mouse_activity       — mouseMoves < 10
 *   superhuman_reaction_time — firstEventLatencyMs < 100ms
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
  console.log('RESULT  [bank-login]');
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
  return apiPost('/api/login/fingerprint', { sessionId, token, fingerprint: fp }, token);
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

// Simulate human keystroke timing for a string: varied inter-key intervals
// with std dev well above the 15ms bot-detection threshold.
function simulateKeystrokes(str) {
  const intervals = [];
  for (let i = 0; i < str.length - 1; i++) {
    intervals.push(Math.floor(80 + Math.random() * 180));
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((s, x) => s + (x - mean) ** 2, 0) / intervals.length;
  const std = Math.sqrt(variance);
  return { count: str.length, std: Math.round(std) };
}

// --- Main ------------------------------------------------------------------

async function run() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [bank-login]\n`);

  const sessionStart = Date.now();

  // 1. Start session
  const session = await apiPost('/api/login/session', {}, null);
  const { sessionId, token, account, panels } = session;

  console.log(`Session:  ${sessionId}`);
  console.log(`Account:  ${account.username}`);
  console.log(`Panels:   real=${panels.realPanelId}  decoy=${panels.decoyPanelId}\n`);

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

  // 3. Simulate reading the login page before typing
  const readDelay = Math.floor(2000 + Math.random() * 2000);
  console.log(`Reading login page for ${Math.round(readDelay / 1000)}s…`);
  await sleep(readDelay);

  // Simulate keystrokes for username and password
  const usernameKs = simulateKeystrokes(account.username);
  const passwordKs = simulateKeystrokes(account.password);
  console.log(`Typing username (${usernameKs.count} keys, std=${usernameKs.std}ms)…`);
  await sleep(Math.floor(account.username.length * 120 + Math.random() * 500));
  console.log(`Typing password (${passwordKs.count} keys, std=${passwordKs.std}ms)…`);
  await sleep(Math.floor(account.password.length * 120 + Math.random() * 500));

  // 4. Submit step 1 — use realPanelId, leave honeypot empty, trapChecked false
  console.log(`Submitting credentials with panel=${panels.realPanelId}…`);
  const step1Result = await apiPost('/api/login/step1', {
    sessionId, token,
    credentials: {
      username:                account.username,
      password:                account.password,
      panelId:                 panels.realPanelId,
      honeypotUsernameConfirm: '',       // leave empty — it's a trap
      trapChecked:             false,    // do not tick the trap checkbox
    },
    telemetry: {
      ...baseTelemetry(),
      passwordKeystrokes:     passwordKs.count,
      passwordPastedNotTyped: false,
      usernamePastedNotTyped: false,
      keystrokeIntervalStd:   Math.max(passwordKs.std, 25), // ensure > 15ms threshold
      usedSsoDecoy:           false,
      trapCheckboxChecked:    false,
    },
  }, token);

  if (!step1Result.ok) {
    const outcome = step1Result.action || 'blocked at step 1';
    printResult(step1Result.risk, outcome);
    return;
  }

  console.log(`Step 1 passed — OTP: ${step1Result.otp}`);

  // 5. Simulate reading the OTP display before submitting
  const otpDelay = Math.floor(2500 + Math.random() * 2000);
  console.log(`Reading OTP display for ${Math.round(otpDelay / 1000)}s…`);
  await sleep(otpDelay);

  // Ensure at least 5s total have elapsed (too_fast gate)
  const elapsed = Date.now() - sessionStart;
  if (elapsed < 5500) {
    const extra = 5500 - elapsed;
    console.log(`Waiting ${extra}ms more to clear 5s gate…`);
    await sleep(extra);
  }

  // 6. Submit step 2 — OTP
  console.log(`Submitting OTP ${step1Result.otp}…`);
  const step2Result = await apiPost('/api/login/step2', {
    sessionId, token,
    otpCode: step1Result.otp,
    telemetry: baseTelemetry(),
  }, token);

  const outcome = step2Result.ok
    ? `${step2Result.action || 'completed'}`
    : (step2Result.action || 'blocked');

  printResult(step2Result.risk, outcome);
  if (step2Result.sessionToken)
    console.log(`Session token: ${step2Result.sessionToken}`);
}

run().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
