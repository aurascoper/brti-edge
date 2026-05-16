# brti-edge

Systematic trading research for **Kalshi 15-minute crypto binary markets** (KXBTC15M, KXETH15M, KXSOL15M, KXBNB15M, KXDOGE15M, KXXRP15M, KXHYPE15M).

The bot is live. The thesis is **not** "any random Brownian model finds alpha here" — that has been measured and rejected. The thesis is that **edge in this market is structural and microstructural**, and lives in:

1. Modeling the *actual settlement object* (CF Benchmarks BRTI 60-second mean), not a single-venue spot proxy.
2. Conditional drift from constituent-venue order-flow imbalance.
3. Heavy-tail correction (Student-t) over Gaussian fair-value.
4. Macro / IV regime gating instead of generic 24/7 trading.

This repo is the work-in-progress toward that thesis. The Kalshi worker is functional; the upgraded fair-value engine is scaffolded.

---

## TL;DR

```text
What's running:  Kalshi 15M crypto worker (TypeScript, tsx-driven)
                 Per-asset inflight, fractional Kelly, contrarian gate,
                 loss-streak backoff, aggregate exposure cap.
What's stubbed:  BRTI aggregator (Coinbase + Kraken + Bitstamp REST)
                 with OFI top-of-book imbalance.
What's next:     Replace fair_yes = Φ(ln(S/K)/(σ√τ)) with the BRTI-aware
                 Student-t formulation in §3 below.
```

---

## 1. Architecture

```text
+-----------------------------+      +--------------------------+
|  Kalshi API (RSA-PSS auth)  |<---->|  KalshiClient + Adapter  |
+-----------------------------+      +--------------------------+
                                              |
                                              v
+----------------+   +-----------+   +---------+   +------------------+
|  Spot feeds    |-->| Strategy  |-->|  Dust   |-->|  Worker HTTP API |
| (Binance.US)   |   | fair_yes  |   | executor|   |   :4001          |
+----------------+   +-----------+   +---------+   +------------------+
                          |                |               |
                          |                v               |
                          |        +-----------------+     |
                          |        | Reconciler poll |     |
                          |        | (fills, results)|     |
                          |        +-----------------+     |
                          |                                |
                          v                                |
                +-----------------+              +---------+----+
                | calibration.json|<-------------| /kalshi/state |
                | (per-asset bias)|              +--------------+
                +-----------------+
                          ^
                          |
            +------------------------+
            | scripts/compute_       |   ← runs every 5 min
            |   calibration.py       |
            +------------------------+

NEW (scaffolded — not yet wired into Strategy):

+----------------+    +----------------+    +----------------+
| Coinbase REST  |--->|                |    |                |
+----------------+    |                |    |    Strategy    |
+----------------+    | BrtiAggregator |--->| (drift-aware,  |
| Kraken REST    |--->|   types,       |    |  Student-t,    |
+----------------+    |   aggregator,  |    |  BRTI σ)       |
+----------------+    |   σ, OFI       |    |                |
| Bitstamp REST  |--->|                |    +----------------+
+----------------+    +----------------+
```

Workspace is a pnpm monorepo:

```
apps/
  market-worker/      Scanning + execution + reconciliation worker (tsx)
    src/kalshi/       Existing Kalshi-specific strategy + executor
    src/brti/         NEW — synthetic BRTI aggregator scaffold
  web/                Next.js read-only operator dashboard
packages/
  kalshi-client/      REST + auth client + venue-neutral adapter
  types/              Shared venue-neutral interfaces
docs/                 Research notes and runbooks (gitignored content stays local)
```

---

## 2. Current model (deployed)

For a Kalshi binary that pays \$1 if a chosen underlying closes at or above a strike `K`, the worker computes a fair YES probability by treating the underlying as drift-free geometric Brownian motion:

```math
\hat p_{\text{YES}}(t) = \Phi\!\Big(\tfrac{\ln(S(t)/K)}{\sigma_{\text{ann}} \sqrt{\tau}}\Big)
```

where

- `Φ` is the standard-normal CDF
- `S(t)` is the most recent Binance.US spot for the underlying
- `K` is the Kalshi `floor_strike`
- `σ_ann` is the annualised realised volatility estimated from a rolling Binance.US tape, multiplied by `KALSHI_SIGMA_MULTIPLIER` (default `2.0` to dampen short-tape model overconfidence)
- `τ = (close_time − now) / (365 × 86400)` is time-to-resolution in years

A trade is emitted when the model edge over the venue ask exceeds the spread + safety + edge floor:

```math
\text{edge}_{\text{YES}} = \hat p_{\text{YES}} - \text{best\_yes\_ask},\qquad
\text{thr} = \tfrac{1}{2}(\text{ask}-\text{bid}) + \text{safety} + \text{edge\_floor}
```

Symmetric logic applies on the NO side via `fair_no = 1 − fair_yes` and `best_no_ask = 1 − best_yes_bid`.

### 2.1 Per-asset calibration correction

Per Le 2026 (arXiv 2602.19520), Kalshi prediction-market calibration has structural per-domain biases. We compute a per-series empirical bias from settled trades

```math
b_d = \frac{1}{N_d} \sum_{i:\,\text{series}=d} \Big(\mathbb{1}\{\text{YES occurred}_i\} - \hat p_{\text{YES},i}^{\text{model}}\Big)
```

and apply a damped correction inside the strategy:

```math
\hat p_{\text{YES,corr}} = \mathrm{clamp}\!\big(\hat p_{\text{YES}} + \alpha\, b_d,\; 0.05,\; 0.95\big),\qquad \alpha \in [0,1]
```

`α = KALSHI_CALIBRATION_ALPHA` defaults to `0.5`. The bias table is regenerated every five minutes from settled trades via `scripts/compute_calibration.py` and hot-reloaded.

> **Open question.** Le 2026 measured Kalshi crypto at 0-1h horizon to have slope `0.99` (i.e., near-perfectly calibrated). Empirically our per-asset biases are likely noise at current `n`. The correction may add variance rather than remove it; see Lessons (§6).

### 2.2 Fractional Kelly sizing

For a binary at ask `A` with model win-probability `p`, the standard Kelly fraction is

```math
f^{*} = \frac{p - A}{1 - A} = \frac{\text{edge}}{1 - A}
```

We apply *fractional* Kelly with a notional bankroll to size the trade:

```math
\text{notional} = \min\Big(\text{maxNotional},\; B \cdot k \cdot f^{*}\Big),\qquad
\text{contracts} = \lfloor \text{notional} / A \rfloor
```

with `B = KALSHI_DUST_KELLY_BANKROLL` and `k = KALSHI_DUST_KELLY_FRACTION` (default 0.25 = "quarter Kelly"). Trades that round to fewer than `minOrderSize` contracts are rejected — Kelly's natural shrinkage on small edges replaces a hard edge-floor filter.

### 2.3 Defensibility filter (auto-submit gate)

Auto-submission requires the candidate pass all of:

| Gate | Env var | Default |
|---|---|---|
| Edge floor | `KALSHI_DEF_EDGE_MIN` | `0.02` |
| Edge cap | `KALSHI_DEF_EDGE_MAX` | `1.0` (effectively removed) |
| Price band | `KALSHI_DEF_PRICE_MIN`, `KALSHI_DEF_PRICE_MAX` | `0.20`–`0.80` |
| Spread cap | `KALSHI_DEF_SPREAD_MAX` | `0.10` |
| Fair-yes saturation | hard-coded | `[0.05, 0.95]` |
| σ in per-asset range | `SIGMA_RANGE[asset]` | see `dustExecutor.ts` |
| Contrarian-market block | `KALSHI_DEF_CONTRARIAN_BID` / `_EDGE_MIN` | `0.55` / `0.15` |
| Coin-flip strike block | `KALSHI_MIN_Z_DISTANCE` | `0.15` (raw σ z) |
| Time to close | `KALSHI_DEF_MIN_SECS_TO_CLOSE` | `90` s |
| Aggregate exposure | `KALSHI_DUST_MAX_AGGREGATE_USD` | `3` |
| Same-side concurrency | `KALSHI_DUST_MAX_SAME_SIDE` | `2` |
| Loss-streak backoff | `KALSHI_DUST_BACKOFF_STREAK` / `_LOSS_USD` / `_SEC` | `3` / `$3` / `300s` |
| Session hard PnL stop | `KALSHI_DUST_HARD_STOP_PNL_USD` | `-15` |
| Trades-per-session cap | `KALSHI_DUST_MAX_TRADES` | `500` |
| Per-trade notional cap | `KALSHI_DUST_MAX_NOTIONAL_USD` | `1` |

---

## 3. Planned model upgrade (BRTI-aware Student-t)

The current model has four documented structural defects:

| Defect | Consequence |
|---|---|
| Settles on `BRTI 60-s mean` but we proxy with `Binance.US spot` | Settlement-object mismatch, especially in final minute |
| `σ` from Binance.US, not BRTI constituents (incl. Bullish 2024-12, Crypto.com 2025-03) | Stale & wrong vol |
| Drift-free Brownian, no OFI / basis input | Cluster losses on directional moves |
| Gaussian tails — Φ underestimates extremes | Wrong probabilities at the wings |

The proposed replacement (per research brief synthesised this session):

```math
\hat p_{\text{YES},t} = 1 - T_{\nu_t}\!\Big(\tfrac{\ln(K / \hat M_{t,\tau}) - \hat\mu_{t,\tau}}{\hat\sigma_{t,\tau}\sqrt{\tau}}\Big)
```

where

- `T_ν` is the Student-t CDF with `ν_t` degrees of freedom (heavy-tail correction over Φ)
- `M̂_{t,τ}` is a **prediction of the final-minute BRTI mean**, not current spot. The cleanest first version: synthetic BRTI extrapolated to the close window using local drift.
- `σ̂_{t,τ}` is **BRTI-derived** realised volatility, not Binance.US
- Conditional drift:

```math
\hat\mu_{t,\tau} = \beta_0 + \beta_1\,\text{OFI}^{(1:5)}_t + \beta_2\,\Delta\text{basis}_t + \beta_3\,r_t^{(1,5,15)} + \beta_4\,\mathbf{1}\{\text{macro/high-IV regime}\}
```

- `OFI^{(1:5)}_t` = order-flow imbalance, top-5 levels across BRTI constituents, 1-second window
- `Δbasis_t` = spot − perp basis change (proxy via CME micro futures or perp funding)
- `r_t^{(1,5,15)}` = recent returns at 1 / 5 / 15-minute lags
- `1{macro/high-IV regime}` = binary flag from FOMC blackout, CPI day, or BVX deviation

### 3.1 Edge threshold under realistic fees

Kalshi's fee schedule (Feb 2026):

```math
\text{fee}_\text{taker} = \lceil 0.07 \cdot C \cdot P \cdot (1-P) \rceil_{\$0.01},\qquad
\text{fee}_\text{maker} = \lceil 0.0175 \cdot C \cdot P \cdot (1-P) \rceil_{\$0.01}
```

where `C` is contracts and `P` is price (rounded **up** to the cent). At `P = 0.50`, taker fee is ≈ 1.75¢ per contract → rounds to **2¢**. Maker fee is ≈ 0.44¢ → rounds to **1¢**.

Minimum viable edge for sustained profitability after fees and slippage is on the order of **2.5–3 cents per contract** for taker flow. The current model's stated edge of 5–10¢ is mostly noise once σ misspecification is unwound; the upgrade must defend a real (not nominal) edge above this hurdle.

---

## 4. BRTI aggregator (scaffolded)

`apps/market-worker/src/brti/`:

```
types.ts                  VenueTick, BrtiSnapshot, OfiFeatures, VenueAdapter
aggregator.ts             BrtiAggregator: rolling 1-s benchmark + σ + OFI
venues/coinbase.ts        Coinbase REST 1-Hz polling (Phase 1)
venues/kraken.ts          Kraken REST 1-Hz polling
venues/bitstamp.ts        Bitstamp REST 1-Hz polling
smoke_test.ts             Standalone validator (passed on initial run)
```

Aggregation rule (`BrtiAggregator.emitSnapshots()`): trimmed mean of constituent mid prices, dropping top and bottom one when ≥5 venues contribute; plain mean when 3-4 contribute. This approximates CF Benchmarks' published BRTI (full method is proprietary).

Annualised σ from 1-second log returns:

```math
\sigma_{\text{ann}}^{\text{BRTI}} = \mathrm{sd}(r_{1\text{s}}) \cdot \sqrt{31{,}536{,}000}
```

Smoke test output (real session):

```text
[smoke] t+5s   BTC=$79047.23 contributors=[coinbase,kraken,bitstamp] OFI=-0.012
[smoke] t+15s  BTC=$79047.68                                         OFI= 0.576
[smoke] t+30s  BTC=$79050.07                                         OFI= 0.447
```

Phase-2 work (deferred): Gemini, itBit, Bullish, Crypto.com adapters; WebSocket migration for true 1-Hz cadence; level-2 depth for full top-5 OFI; aggressor-flow from public trade tape.

---

## 5. Configuration reference

Full env-var surface (defaults shown). Set in `.env` or pass at launch:

```text
# Kalshi credentials (required) — pulled from /Users/.../.env at runtime
KALSHI_API_KEY_ID            <uuid>
KALSHI_PRIVATE_KEY_PEM       <RSA PEM>

# Safety switches (defense in depth)
KALSHI_ALLOW_ORDERS                  0  # 1 = LIVE, 0 = no orders ever
KALSHI_AUTO_SUBMIT                   0  # 1 = auto-confirm + submit defensible candidates

# Strategy knobs
KALSHI_SIGMA_MULTIPLIER             1.0  # inflate raw σ before fair-value
KALSHI_MIN_Z_DISTANCE               0.0  # reject coin-flip strikes (|z| < this)
KALSHI_CALIBRATION_ALPHA            0.5  # how much per-asset bias to apply
KALSHI_CALIBRATION_INTERVAL_MS    300000 # recompute calibration.json every 5 min

# Defensibility filter
KALSHI_DEF_EDGE_MIN                 0.02
KALSHI_DEF_EDGE_MAX                 0.10
KALSHI_DEF_PRICE_MIN                0.20
KALSHI_DEF_PRICE_MAX                0.80
KALSHI_DEF_SPREAD_MAX               0.10
KALSHI_DEF_MIN_SECS_TO_CLOSE        90
KALSHI_DEF_CONTRARIAN_BID           0.6
KALSHI_DEF_CONTRARIAN_EDGE_MIN      0.15

# Dust executor
KALSHI_DUST_ENABLED                 1
KALSHI_DUST_MAX_NOTIONAL_USD        1
KALSHI_DUST_MAX_TRADES              5
KALSHI_DUST_MANUAL_CONFIRM_FIRST_N  3
KALSHI_DUST_HARD_STOP_PNL_USD       -2
KALSHI_DUST_CANDIDATE_TTL_SEC       75
KALSHI_DUST_MIN_ORDER_SIZE          1
KALSHI_DUST_MAX_AGGREGATE_USD       3
KALSHI_DUST_MAX_SAME_SIDE           2
KALSHI_DUST_BACKOFF_STREAK          3
KALSHI_DUST_BACKOFF_LOSS_USD        3
KALSHI_DUST_BACKOFF_SEC             300

# Kelly sizing
KALSHI_DUST_USE_KELLY               1
KALSHI_DUST_KELLY_FRACTION          0.25
KALSHI_DUST_KELLY_BANKROLL          20
```

Worker HTTP endpoints (read-only unless `KALSHI_ALLOW_ORDERS=1`):

```
GET  /health
GET  /kalshi/state
GET  /kalshi/dust/state
POST /kalshi/dust/confirm/{id}
POST /kalshi/dust/decline/{id}
POST /kalshi/dust/submit/{id}
```

---

## 6. Lessons from live session 2026-05-15/16

A 116-trade live session over ~8 hours produced **cum_pnl = -$11.31** and the following load-bearing learnings:

### 6.1 Bugs found and patched

| Bug | Symptom | Fix |
|---|---|---|
| Reconciler used wrong field path (`raw.market.result` vs `raw.result`) | Every win silently misreported as loss | `dustExecutor.reconcileOne()` |
| Reconciler raced market.result propagation | Fresh wins flipped to losses before Kalshi published result | Wait for explicit `"yes"`/`"no"` before terminalising |
| Worker scan loop early-returned on **any** global inflight | Only one series ever fired (BTC dominated) | Removed early-return; rely on per-series gate in dustExecutor |
| `KalshiOrder` / `KalshiFill` types referenced wrong API fields | Reconciler couldn't parse fills | Updated to `count_fp`, `yes_price_dollars`, etc. |

### 6.2 Structural insights

1. **Kelly + scaling amplifies variance, not edge, in a near-efficient market.** Peak +$10.36 to trough −$11.31 in 8 hours on a "filter that was working" demonstrated cluster correlation across 7 simultaneously-expiring crypto markets: same-side bets become one bet.
2. **Per-asset calibration biases at n < 30 are noise.** The `b_d` estimates we computed (BTC −0.124, SOL +0.104, etc.) are smaller than the [-0.024, +0.034] noise band from Le 2026's `n = 65M` Bayesian posterior on Kalshi crypto. We were correcting against statistical noise.
3. **The market we picked is structurally near-zero-edge.** Le 2026 measures Kalshi crypto at 0-1h horizon to have slope `0.99` (effectively calibrated). Prediction Arena 2026 shows frontier LLMs lost 16–30% on this venue. TimeSeek 2026 shows model edge collapses near resolution — exactly where 15-min markets live.
4. **Our σ source is wrong.** Settlement is on BRTI (multi-venue, with Bullish + Crypto.com added 2024–2025); we estimate σ from Binance.US alone.

### 6.3 The thesis going forward

Edge — if extractable in this market — is in the settlement-window microstructure, not in a better σ estimate for `Φ(ln(S/K)/(σ√τ))`. Hence the BRTI aggregator scaffold and the proposed model in §3.

---

## 7. Pilot plan (Week 1 → Week 4)

Working toward the upgraded model in §3:

```text
Week 1  Scaffold BRTI aggregator + smoke-test            ← DONE
        Replace σ source from Binance.US to BRTI         ← next
        Validate σ_BRTI against Kalshi settlement prints

Week 2  Add OFI top-5 from BRTI constituents (WS migration required)
        Add spot-perp basis feature (CME micro or perp funding)
        Wire conditional drift μ̂ into fair_yes
        Add macro-day regime flags (FOMC, CPI)

Week 3  Replace Φ with Student-t with ν fit per asset
        Add time-of-day gating (only trade 13:55–17:05 UTC initially)
        Run 1-week paper trade vs current model in parallel

Week 4  If Brier-skill improvement ≥5% and net edge ≥2.5¢/contract:
          Ramp live capital
        If not: iterate on heavy-tail family (asymmetric Laplace)
          OR pivot to longer horizons (Le 2026 says 24-48h crypto
          slope is 1.21 — 21% underconfident, real arb opportunity)
```

---

## 8. Running locally

```bash
# Install
pnpm install

# Launch worker (LIVE — needs Kalshi creds in /Users/<you>/Developer/live_trading/.env)
cd apps/market-worker
KALSHI_ALLOW_ORDERS=1 KALSHI_AUTO_SUBMIT=1 \
  KALSHI_SIGMA_MULTIPLIER=2.0 KALSHI_MIN_Z_DISTANCE=0.15 \
  KALSHI_DEF_CONTRARIAN_BID=0.55 \
  KALSHI_DUST_MAX_NOTIONAL_USD=1 KALSHI_DUST_MAX_TRADES=500 \
  KALSHI_DUST_HARD_STOP_PNL_USD=-15 KALSHI_DUST_MANUAL_CONFIRM_FIRST_N=0 \
  KALSHI_DUST_USE_KELLY=1 KALSHI_DUST_KELLY_FRACTION=0.25 \
  KALSHI_DUST_KELLY_BANKROLL=20 KALSHI_CALIBRATION_ALPHA=0.5 \
  pnpm dlx tsx src/kalshi/worker.ts

# Smoke-test BRTI aggregator (no money risk)
cd apps/market-worker
pnpm exec tsx src/brti/smoke_test.ts

# Run web dashboard
cd apps/web
pnpm dev   # http://localhost:3000
```

To disarm all live trading at once: `KALSHI_ALLOW_ORDERS=0`.

---

## 9. References (load-bearing)

1. **Le, N. A. (2026).** *Decomposing Crowd Wisdom: Domain-Specific Calibration Dynamics in Prediction Markets.* arXiv:2602.19520. — Establishes Kalshi crypto at 0-1h is calibrated (slope 0.99). Political markets at long horizons have slope 1.74 — the highest published edge.
2. **Mohanty, H., Krishnamachari, B. (2026).** *Do Prediction Markets Forecast Cryptocurrency Volatility? Evidence from Kalshi Macro Contracts.* arXiv:2604.01431. — KXFED/KXCPI/KXRECSSNBER prices carry crypto-vol info not in Fed funds futures, Treasury yields, or Deribit DVOL.
3. **Zhang, J. et al. (2026).** *Prediction Arena: Benchmarking AI Models on Real-World Prediction Markets.* arXiv:2604.07355. — Frontier LLMs lost 16–30% over 57 days on Kalshi; on Polymarket, average −1.1%, top model +71% win rate.
4. **Mostafa, H., Shastri, O., Lee, D. (2026).** *TimeSeek: Temporal Reliability of Agentic Forecasters.* arXiv:2604.04220. — Model competitiveness deteriorates near resolution. 15-min markets at 5 min from close are the worst window.
5. **Galekwa, R. et al. (2026).** *Toward Sports Betting as a Financial Asset.* IEEE Access. — KL-divergence-penalised Kelly criterion. Reduces ruin probability 78%→<2%.
6. **Nayar, R. et al. (2026).** *Topological Risk Parity.* arXiv:2604.16773. — Tree-based portfolio construction for clusters that spike in correlated crises.

---

## 10. Status

```text
Last live session:  2026-05-15/16   116 trades   cum_pnl: -$11.31
Worker:             halted (no Kalshi exposure)
BRTI scaffold:      smoke-tested OK
Next:               wire BRTI σ into strategy, then add OFI
```

The financial loss is the cost of the lessons logged in §6. The structure proposed in §3 is the path forward.
