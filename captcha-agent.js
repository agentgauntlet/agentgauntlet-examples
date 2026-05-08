#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — image-captcha scenario
 *
 * The server returns 9 base64-encoded PNG images in the session response.
 * This agent sends all 9 to Claude in a single multi-image message and
 * asks which ones match the challenge instruction (e.g. "traffic light").
 * No browser interaction with a page — images travel entirely via JSON.
 * A browser is still launched briefly to produce a realistic fingerprint.
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
  console.log('RESULT  [captcha]');
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
  return apiPost('/api/captcha/fingerprint', { sessionId, token, fingerprint: fp }, token);
}

// --- Telemetry stub -------------------------------------------------------

function telemetry(clickCount) {
  return {
    mouseMoves:          Math.floor(12 + Math.random() * 20),
    clickCount,
    clickDwellMedian:    Math.floor(80 + Math.random() * 120),
    keystrokeCount:      0,
    mouseVelocityMean:   Math.floor(200 + Math.random() * 300),
    mouseVelocityStd:    Math.floor(50  + Math.random() * 100),
    firstEventLatencyMs: Math.floor(1500 + Math.random() * 2000),
  };
}

// --- Claude CAPTCHA solver ------------------------------------------------

async function solveCaptcha(challenge) {
  const { instruction, images } = challenge;

  // Send all 9 images to Claude in one message. Each image is one cell of
  // the 3×3 grid, numbered 0–8 left-to-right, top-to-bottom.
  const content = [
    {
      type: 'text',
      text: [
        `CAPTCHA: "${instruction}"`,
        `Below are the 9 grid images numbered 0–8 (left-to-right, top-to-bottom).`,
        `Reply with ONLY a JSON array of the indices that match, e.g. [0, 3, 7].`,
      ].join('\n'),
    },
  ];
  for (const img of images) {
    const base64 = img.data.replace(/^data:image\/\w+;base64,/, '');
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  }

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 64,
    system:     'You are a CAPTCHA solver. Identify which grid images match the instruction. Reply with only a JSON array of zero-based indices. No explanation.',
    messages:   [{ role: 'user', content }],
  });

  const raw   = msg.content[0].text.trim();
  const match = raw.match(/\[[\d,\s]*\]/);
  if (!match) throw new Error(`Unexpected Claude response: "${raw}"`);
  const indices = JSON.parse(match[0]);
  console.log(`Claude indices: ${JSON.stringify(indices)}`);
  return indices.map(i => images[i]?.id).filter(Boolean);
}

// --- Main -----------------------------------------------------------------

async function run() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [captcha]\n`);

  // 1. Start session — server returns 9 base64 PNG images + instruction
  const session = await apiPost('/api/captcha/session', {}, null);
  const { sessionId, token, challenge, risk: sessionRisk } = session;
  console.log(`Session:   ${sessionId}`);
  console.log(`Challenge: "${challenge.instruction}"`);
  console.log(`Images:    ${challenge.images.length} in a ${challenge.gridSize}×${challenge.gridSize} grid\n`);

  if (sessionRisk?.action === 'block') {
    printResult(sessionRisk, 'blocked at session start');
    return;
  }

  // 2. Launch browser briefly to compute a real fingerprint
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

  // 3. Send all 9 images to Claude — get matching indices → IDs
  console.log('Asking Claude to classify images…');
  const selectedIds = await solveCaptcha(challenge);
  console.log(`Selected:  [${selectedIds.join(', ')}] (${selectedIds.length} images)`);

  // Pause realistically — submitting in < 1.5s triggers captcha_solved_too_fast
  const dwellMs = Math.floor(3500 + Math.random() * 3000);
  await new Promise(r => setTimeout(r, dwellMs));

  // 4. Submit solution
  const result = await apiPost('/api/captcha/solve', {
    sessionId, token, selectedIds,
    telemetry: telemetry(selectedIds.length),
  }, token);

  const outcome = result.ok ? 'completed' : (result.action || 'blocked');
  printResult(result.risk, outcome);
  if (result.verificationId) console.log(`Verification ID: ${result.verificationId}`);
}

run().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
