# PolySwarm (Barot & Borkhatariya, 2026) — architectural extract

**Paper**: PolySwarm: A Multi-Agent Large Language Model Framework for Prediction Market Trading and Latency Arbitrage
**arXiv**: 2604.03888
**Authors**: Rajat M. Barot (SUNY Binghamton), Arjun S. Borkhatariya (Arizona State)
**Date**: 2026-04-04
**License**: CC BY-NC-ND 4.0
**Citations**: 0 (recent)

## What polyterminal already implements

Latency-arb subsystem only. fairValueArb is the CEX-implied log-normal piece:
```
p_cex = Φ(ln(S/K) / (σ√T))   ← exact match to paper's eq.
```
Where S = spot, K = strike, σ = hourly vol, T = hours to expiry.

This is one of three subsystems in PolySwarm. Everything else is unbuilt.

## Full system in PolySwarm

### 1. 50-persona LLM swarm

- **PERSONA_POOL**: 50 distinct personas (macro economist, technical analyst, contrarian investor, political scientist, sports statistician, public health expert, domain specialists)
- **Per evaluation**: sample 25 agents w/o replacement (default; configurable)
- **Per-agent prompt**: chain-of-thought elicitation — agent must articulate reasoning, uncertainty sources, confidence level before committing to a numerical probability
- **Multi-provider inference**: Anthropic (Claude series), OpenAI (GPT series), self-hosted Ollama (LLaMA, Mistral) — distribute for cost/quality tradeoffs
- **Caching**: aiosqlite with TTL — avoid redundant API calls when market state hasn't materially changed
- **Independence**: market-implied probability is **withheld** from individual agent prompts; agents only see it at aggregation stage. Preserves prediction independence (essential for wisdom-of-crowds to work).

### 2. Two-stage Bayesian aggregation

**Stage 1** — confidence-weighted swarm consensus:
```
p_swarm = Σ wᵢ·pᵢ / Σ wᵢ
```
where pᵢ = agent i's predicted probability, wᵢ = agent reliability weight (track-record-based)

**Stage 2** — linear Bayesian mixture with market prior:
```
p_combined = 0.70 × p_swarm + 0.30 × p_market
```

The 70/30 weighting is a tunable hyperparameter:
- Higher market weight → conservative, fewer trades
- Higher swarm weight → larger positions on swarm-vs-market disagreement

### 3. Trade trigger conditions

```
EV = p_combined × b - (1 - p_combined)
```
where b = net decimal odds of YES outcome implied by current market price.

**Enter trade only if BOTH:**
- EV > 5% (configurable `MIN_EV_THRESHOLD`)
- Swarm σ < 30% (uncertainty filter — wide swarm = epistemic doubt)

### 4. Position sizing — quarter-Kelly

Kelly: f* = (bp - q) / b where p = win prob, q = 1-p, b = net odds

PolySwarm uses **f*/4** (quarter-Kelly) as the conservative variant. Caps via:
- `MAX_POSITION_USDC` — hard per-trade ceiling
- `DAILY_LOSS_LIMIT_USDC` — kills scan loop when cumulative pnl ≤ limit (essential first-order risk)

### 5. Cross-market arbitrage detector (information-theoretic)

**KL divergence** (Eq. 4):
```
D_KL(P_swarm || P_market) = Σ P_swarm(x) log[P_swarm(x) / P_market(x)]
```
Large KL → swarm meaningfully disagrees with market.

**JS divergence** (Eq. 5, symmetric + bounded):
```
D_JS(P || Q) = ½ D_KL(P || M) + ½ D_KL(Q || M)   where M = ½(P + Q)
```
Bounded in [0, log 2]. Easier to threshold.

**Negation pair detector**: scan market titles for "E" + "¬E" pairs (semantic similarity over titles). No-arb requires P(E) + P(¬E) = 1. Deviation → immediate riskless arb.

**Mutually-exclusive partition check**: when N markets cover an exhaustive partition (e.g., "Q1 GDP growth bucket A/B/C/D"), Σ probabilities should = 1. Sum deviation → all-markets mispricing.

**Bayesian network consistency**: cross-check P(B|A) implied vs P(A)·P(B|A) for correlated markets.

### 6. Latency arbitrage

Same log-normal model as our fairValueArb. Operates on the 5-second scan loop.

For event-news markets (politics, breaking news): LLM classifies directional impact of breaking news, submits order within human reaction-time window. This is the part that beats human polymarket.com traders who read → think → click.

### 7. Scan loop architecture

- **5-second cycle** — Polymarket Gamma REST API
- **asyncio + bounded semaphore** for concurrent LLM inference (rate-limit compliance + predictable latency)
- **Volume / activity filters** before swarm dispatch
- **FastAPI + Vue 3** dashboard via WebSocket

### 8. Tech stack

```
backend:     Python FastAPI
frontend:    Vue 3 + WebSocket
async I/O:   asyncio with bounded semaphore
DB:          aiosqlite (cache + persistence)
LLM:         multi-provider (Anthropic / OpenAI / Ollama)
execution:   py-clob-client (Polymarket CLOB API)
chain:       Polygon PoS
```

## Open challenges (from §VII)

1. **Hallucination in agent pools** — correlated errors if personas trained on similar data
2. **Computational cost at scale** — 50 LLM calls × N markets × 5sec loop = real money on inference
3. **Market impact** — large positions move prices, creating feedback loops
4. **Regulatory exposure** — Polymarket access restrictions in US; Kalshi under CFTC oversight
5. **Feedback-loop risk** — if many bots use similar LLM-based strategies, alpha decays fast

## Gap analysis vs polyterminal

| PolySwarm subsystem | polyterminal status |
|---|---|
| 50-persona LLM swarm | ❌ not built |
| Confidence-weighted aggregation | ❌ not built |
| Bayesian market-prior mixture (70/30) | ❌ not built (we use raw fairValueArb output) |
| EV > 5% trigger | ❌ no EV calculation; we use edge > threshold |
| Swarm σ < 30% filter | ❌ no swarm; single-strategy decisions |
| Quarter-Kelly sizing | ❌ fixed-notional ($1, now $3) cap |
| KL/JS divergence detector | ❌ not built |
| Negation pair scanner | ❌ not built |
| Latency arb (log-normal CEX) | ✅ fairValueArb |
| 5s scan loop | ✅ worker shadow loop (matches cadence) |
| asyncio + semaphore | ✅ Node.js equivalent (Promise.all bounded) |
| aiosqlite cache | △ JSONL append-only (different but functional) |
| Multi-provider LLM | ❌ no LLM integration |
| FastAPI + Vue 3 dashboard | △ Next.js dashboard (functional equivalent) |
| Polymarket CLOB execution | ⚠️ blocked on sigType=3 auth bug |

## Implementation priority for polyterminal upgrade

(Order = dependency + value-density)

1. **Fix sigType=3 execution** — gates everything. Without this no real fills.
2. **Local signer daemon** — once #1 works, automate signing so multi-market parallel becomes feasible.
3. **Quarter-Kelly sizing** — replace fixed-notional. Trivial change, big improvement on capital efficiency.
4. **Multi-market parallel scan** — generalize the BTC-only worker to scan N markets per cycle.
5. **Negation pair detector** — easy win (no LLM needed). Just title-similarity over active markets.
6. **LLM swarm for one non-BTC market type** — start with NBA (Paper 2's domain). Single persona first, then 5, then 25. Use Ollama Cloud (deepseek-v4-pro) to keep costs near zero.
7. **EV-based trigger + Bayesian mixture** — replace edge>threshold gate.
8. **KL/JS divergence inefficiency scoring** — once swarm probabilities exist, divergence is one line of code.

Steps 1+2 are the bottleneck. Steps 3-5 deliver leverage on the strategy we already have. Steps 6-8 expand strategy surface.

## Architectural lessons from PolySwarm specifically applicable to us

- **Withhold market price from agents during inference** — preserves independence. If we add LLM features later, agents should see news + structured data, NOT the order book.
- **Track-record-based agent weighting** — log Brier scores per persona per market category, use for wᵢ. Need a metrics persistence layer we don't have yet.
- **Daily loss limit at scan loop level** — currently we have a -$2 hard stop checked per-candidate. PolySwarm-style daily limit suspends the entire scan, not just blocks new entries. Cleaner.
- **Paper vs live trading mode toggle** — they have an explicit mode switch. We have ENABLED/LIVE env vars which serve similar purpose but less clearly separated.
- **No-LLM detectors first** — negation pairs and partition sum checks need zero LLM. Should ship before any swarm work.
