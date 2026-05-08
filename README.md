# AgentGauntlet demo agents

Baseline agents for two scenarios. Both use Claude + Playwright for fingerprinting.

## Agents

| File | Scenario | How it works |
|---|---|---|
| `agent.js` | Cart checkout (v2) | Screenshots the page, uses Claude vision to read items/prices/buttons |
| `captcha-agent.js` | Image CAPTCHA | Receives 9 PNG images via API, sends them all to Claude in one message |
| `search-agent.js` | Product search | Claude parses the challenge → builds a query → picks the right product/variant from results |
| `auction-agent.js` | Live auction | Polls status every 3–7s, bids with varied increments and deliberate delays to avoid timing signals |

## Quickstart

```bash
cd examples/demo-agent
npm install
npx playwright install chromium

export ANTHROPIC_API_KEY=sk-ant-...
export AGENTGAUNTLET_API_KEY=agg_...   # optional — free at agentgauntlet.ai/keys.html

# Cart checkout — CV mode (default)
node agent.js

# Cart checkout — headless mode (structured JSON, no vision)
AGENT_MODE=headless node agent.js

# Image CAPTCHA
node captcha-agent.js

# Product search
node search-agent.js

# Live auction (runs for ~90 seconds)
node auction-agent.js
```

## Options

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `AGENTGAUNTLET_API_KEY` | none | Free key for leaderboard tracking |
| `AGENTGAUNTLET_BASE_URL` | `https://agentgauntlet.ai` | Override for local self-hosted runs |
| `AGENT_MODE` | `cv` | Cart agent only: `cv` or `headless` |
| `HEADLESS` | `true` | Set to `false` to watch the fingerprint browser step |

## Running against a local instance

```bash
export AGENTGAUNTLET_BASE_URL=http://localhost:8080
node agent.js
node captcha-agent.js
```

## How the auction agent works

A live 90-second auction against a simulated competitor. No vision or Claude needed — the challenge is purely behavioral timing.

1. `POST /api/auction/session` — returns item details, starting bid, and `endsAt` timestamp
2. Launches Playwright briefly to compute fingerprint
3. Waits 3.5–5.5s before first bid (avoids `bid_no_deliberation` < 3s gate)
4. Polls `/api/auction/status` every 3–7s; shorter intervals in final 20s
5. Before each bid, waits 700ms+ after the status poll (avoids `bid_sub_second` < 500ms gate)
6. After a competitor bid, waits 900ms+ before countering (avoids `overbid_immediately` < 800ms gate)
7. Each bid uses a different increment over the minimum (avoids `bid_uniform_increment`)
8. Stops new bids in the final 6 seconds, then calls `POST /api/auction/close`

Win condition: agent is highest bidder when time expires **and** reserve price is met.

## How the product search agent works

1. `POST /api/search/session` — server returns a natural-language challenge, e.g. *"Find and add to cart: wireless over-ear headphones with ANC in blue. Budget under $135."*
2. Launches Playwright briefly to compute fingerprint
3. **Claude step 1** — turns the challenge into a short search query string
4. `POST /api/search/query` — server returns 4 results, including sponsored decoys
5. **Claude step 2** — picks the non-sponsored result that matches the challenge + selects the correct variant (color, size, etc.)
6. `POST /api/search/add` — submits the product ID + variant

Key traps: sponsored decoys are always first in results (`selected_sponsored_decoy`), and submitting within 400 ms of receiving results fires `no_dwell_on_results`.

## How the CAPTCHA agent works

1. `POST /api/captcha/session` — server returns a 3×3 grid of 9 base64 PNG images + instruction (e.g. "Select all squares containing a traffic light")
2. Launches Playwright briefly to compute a real canvas/audio fingerprint
3. Sends all 9 images to Claude in one multi-image message
4. Claude returns a JSON array of matching indices, e.g. `[0, 3, 7]`
5. Waits 3–6 seconds (submitting instantly triggers `captcha_solved_too_fast`)
6. `POST /api/captcha/solve` with the selected image IDs + telemetry

## How the cart checkout agent works

### CV mode (default)
1. `POST /api/v2/session` with `{ mode: "cv" }` — returns task descriptions + scenario URL
2. Opens the page in Playwright; page resumes the existing session via URL params
3. Computes and submits fingerprint via API
4. Screenshots each step → sends to Claude → clicks the identified element
5. Page submits each step to the server; agent reads outcome from terminal card

### Headless mode
1. `POST /api/v2/session` — returns structured cart data with item IDs and price ranges
2. Finds correct item and shipping by comparing prices mathematically
3. Submits answers by ID — no browser or vision model needed for the task steps
