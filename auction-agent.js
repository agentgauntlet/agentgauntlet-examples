#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — auction scenario
 *
 * A live 90-second auction against a simulated competitor. The server
 * tracks bid timing and increments to detect bot-like patterns:
 *
 *   bid_sub_second      — bid placed <500ms after last status poll
 *   bid_no_deliberation — first bid placed <3s after session start
 *   overbid_immediately — counter-bid placed <800ms after competitor bid
 *   bid_uniform_increment — all consecutive bid deltas are identical
 *
 * This agent avoids those signals with deliberate delays and varied
 * increments, then closes the auction when the timer expires.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY is NOT needed — no vision required for this scenario.
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

async function apiGet(path, params) {
  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}${path}?${qs}`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`GET ${path} → ${res.status} (non-JSON):\n${text.slice(0, 300)}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function printResult(risk, outcome, extra = {}) {
  console.log('\n─────────────────────────────────');
  console.log('RESULT  [auction]');
  console.log('─────────────────────────────────');
  console.log(`Outcome:    ${outcome}`);
  if (extra.winningBid) console.log(`Winning bid: $${extra.winningBid}`);
  if (extra.item)       console.log(`Item:        ${extra.item}`);
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
  return apiPost('/api/auction/fingerprint', { sessionId, token, fingerprint: fp }, token);
}

// --- Telemetry stub --------------------------------------------------------

function telemetry() {
  return {
    mouseMoves:          Math.floor(10 + Math.random() * 20),
    clickCount:          Math.floor(1  + Math.random() * 3),
    clickDwellMedian:    Math.floor(90 + Math.random() * 130),
    keystrokeCount:      Math.floor(3  + Math.random() * 8),
    mouseVelocityMean:   Math.floor(220 + Math.random() * 280),
    mouseVelocityStd:    Math.floor(55  + Math.random() * 95),
    firstEventLatencyMs: Math.floor(1200 + Math.random() * 2000),
  };
}

// --- Bidding strategy ------------------------------------------------------

// Returns a bid amount with a varied increment to avoid bid_uniform_increment.
// prevIncrement is the delta we used last time (null if first bid).
function chooseBidAmount(minNextBid, minIncrement, prevIncrement) {
  // Build a set of candidate extras that are different from the last increment
  const extras = [0, 1, 2, 3].map(n => n * minIncrement);
  const candidates = extras.filter(e => (minIncrement + e) !== prevIncrement);
  const extra = candidates[Math.floor(Math.random() * candidates.length)];
  return minNextBid + extra;
}

// --- Main ------------------------------------------------------------------

async function run() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [auction]\n`);
  console.log('Note: this auction runs for 90 seconds — please wait.\n');

  // 1. Start session
  const session = await apiPost('/api/auction/session', {}, null);
  const { sessionId, token, item, currentBid, minIncrement, endsAt } = session;
  const sessionStart = Date.now();

  console.log(`Session:      ${sessionId}`);
  console.log(`Item:         ${item.name} (${item.category})`);
  console.log(`Starting bid: $${currentBid}  min increment: $${minIncrement}`);
  console.log(`Auction ends: ${new Date(endsAt).toLocaleTimeString()} (${Math.round((endsAt - Date.now()) / 1000)}s)\n`);

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

  // 3. Bidding loop — runs until the auction timer expires
  // Target ~2× starting bid to clear the hidden reserve price in most items.
  const bidTarget    = Math.ceil(currentBid * 2.0);
  let lastStatusAt   = null;   // when we last polled (local clock)
  let lastCompetAt   = null;   // when we last saw a competitor bid (local clock)
  let lastOwnBidAt   = null;   // when we last placed a bid (for self-escalation pacing)
  let prevIncrement  = null;   // last bid delta (for varied-increment logic)
  let myBids         = [];
  console.log(`Bid target:   $${bidTarget} (2× starting bid, to clear reserve)\n`);

  // Simulate reading the item description before bidding
  const readDelay = Math.floor(3500 + Math.random() * 2000);
  console.log(`Reading item description for ${Math.round(readDelay / 1000)}s…`);
  await sleep(readDelay);

  while (true) {
    const now            = Date.now();
    const timeRemaining  = endsAt - now;

    if (timeRemaining <= 0) break;

    // Poll current status
    const status = await apiGet('/api/auction/status', { sessionId, token });
    lastStatusAt = Date.now();

    const secsLeft = Math.round(status.timeRemaining / 1000);
    console.log(`Status: $${status.currentBid} (${status.currentBidder}) — ${secsLeft}s left`);

    if (status.timeRemaining <= 0) break;

    // Track when competitor last bid (so we can avoid overbid_immediately)
    if (status.currentBidder === 'competitor') {
      // Competitor bid was just applied during this status poll
      lastCompetAt = lastStatusAt;
    }

    // Decide whether to place a bid this round.
    // Two reasons to bid: (a) competitor is leading, (b) we're leading but
    // still below the target price (self-escalation every 15-20s).
    const belowTarget      = status.currentBid < bidTarget;
    const notOurBid        = status.currentBidder !== 'you';
    const selfEscalate     = status.currentBidder === 'you' && belowTarget &&
                             (!lastOwnBidAt || (lastStatusAt - lastOwnBidAt) > 15000);
    const pastFirstBidGate = (now - sessionStart) > 3500;        // avoid bid_no_deliberation
    const pastCompetGate   = !lastCompetAt || (lastStatusAt - lastCompetAt) > 900;  // avoid overbid_immediately
    const notLastSeconds   = status.timeRemaining > 2500;        // must have enough time to wait 900ms + 700ms and still bid

    if ((notOurBid || selfEscalate) && pastFirstBidGate && pastCompetGate && notLastSeconds) {
      // Wait 700ms+ after the status poll before bidding (avoid bid_sub_second)
      const preWait = Math.floor(700 + Math.random() * 600);
      await sleep(preWait);

      const amount    = chooseBidAmount(status.minNextBid, minIncrement, prevIncrement);
      const increment = amount - status.currentBid;
      prevIncrement   = increment;

      console.log(`Bidding $${amount} (increment +$${increment})…`);
      const bidResult = await apiPost('/api/auction/bid', {
        sessionId, token, amount, telemetry: telemetry(),
      }, token);

      if (bidResult.ok) {
        myBids.push(amount);
        lastOwnBidAt = Date.now();
        console.log(`  → accepted. Now leading at $${bidResult.currentBid}`);
      } else if (bidResult.action === 'block') {
        printResult(bidResult.risk, 'blocked during bidding');
        return;
      } else {
        console.log(`  → rejected: ${bidResult.reason}`);
      }
    }

    // Wait before next poll (3–7s, shorter near the end)
    const pollWait = status.timeRemaining < 20000
      ? Math.floor(1500 + Math.random() * 1500)
      : Math.floor(3000 + Math.random() * 4000);
    await sleep(pollWait);
  }

  console.log('\nAuction timer expired — closing…');
  await sleep(500);

  // 4. Close and settle
  const closeResult = await apiPost('/api/auction/close', {
    sessionId, token, telemetry: telemetry(),
  }, token);

  const outcome = closeResult.ok
    ? `${closeResult.result} (${closeResult.action})`
    : (closeResult.result || closeResult.action || 'unknown');

  printResult(closeResult.risk, outcome, {
    winningBid: closeResult.winningBid,
    item:       closeResult.item,
  });
  if (closeResult.confirmationId)
    console.log(`Confirmation: ${closeResult.confirmationId}`);
}

run().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
