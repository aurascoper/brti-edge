# brti-edge

Systematic trading research for **Kalshi 15-minute crypto binary markets** (KXBTC15M, KXETH15M, KXSOL15M, KXBNB15M, KXDOGE15M, KXXRP15M, KXHYPE15M, KXBCH15M, KXADA15M).

Live trading is **paused** as of 2026-05-17. Six rounds (n = 285 filled trades, $51.25 → ~$18 bankroll) produced one strong finding and one decisive negative result:

| Result | Evidence |
|---|---|
| ✓ **BRTI ≫ Binance** as Kalshi's settlement source | Out of 188 disagreements between the two windowed means, BRTI matched Kalshi 168 times (89.4%). Binomial p = 1.27 × 10⁻³⁰. |
| ✗ **No post-hoc transform of `fair_yes = Φ(z)` clears the live-edge gate** | Walk-forward filled-trade Brier of Gaussian, clip, logistic, and Student-t models all land within ±0.01 of climatology 0.250. Best skill 0.93%, gate requires ≥5%. |

The thesis has narrowed. Calibration is not the bottleneck — **new features are**. The repo's current focus is the *Layer 1 / Layer 2 bakeoff system* that lets us add candidate features (spot-perp basis, OFI, basis-change, …) one at a time, score them prospectively against settlement, and require they beat the gate before any live retest.

**Parallel research thread (2026-05-26, Section 13).** A second path now runs alongside the signal-model work: an execution-side **maker-replay harness** that consumes a 30 h Kalshi WebSocket capture and simulates hypothetical resting maker quotes against the historical tape. The dumb two-sided `BTC_TOUCH_DEPTH50` policy was tested and rejected on robustness grounds; a refined policy `BTC_YES_LATE_ASIA_v1` is **pre-registered** awaiting fresh-week holdout collection. No live orders. See §13.

---

## TL;DR

```text
What runs in shadow:  Kalshi 15M worker (TS, tsx-driven)
                      KALSHI_ALLOW_ORDERS=0 / AUTO_SUBMIT=0 / DUST_ENABLED=0
                      + BRTI aggregator (Coinbase + Kraken + Bitstamp REST)
                      + settlement-print validator (BRTI vs Binance A/B)
                      + perp-basis feed (Kraken Futures PF_*USD)
                      + Layer-2 model-bakeoff logger (1 row per scan tick)

What's frozen:        285 filled trades + 871 settlement-validation rows.
                      Live state preserved, ledger committed at
                      docs/run-ledgers/kalshi-r1-r6-ledger.jsonl

What's offline:       scripts/brier_bakeoff.py — Layer-1 walk-forward
                      bakeoff over Gaussian, clip, logistic, Student-t.
                      Reproduces the negative result above.

What's next:          Layer-2 shadow accumulation of basis features
                      → re-run brier_bakeoff.py → if it clears the gate,
                      R7 launches with the augmented model in a tight
                      bankroll envelope. If not, next feature: OFI top-5.
```

---

## 1. Session ledger (R1 → R6)

```text
Round   Config                                  n     Win%    PnL          Note
─────────────────────────────────────────────────────────────────────────────────
R1      Kelly=$20, no filters                   30   ~60%    +$3.23       baseline
R2      +KALSHI_DEF_SIGMA_MAX=0.40               30   50.0%   −$1.48       σ ceiling added
R3      +KALSHI_DEF_YES_MIN_EDGE=0.15            30   70.0%   +$9.48       only profitable round
R4      Kelly bumped $50→$250 mid-round          21   ~30%    −$29.82      Kelly overbet, hard-stop hit
R5      Reverted to R3 config (US-morning)       25   33%     −$5.43       early halt
R6      R3 config (US-evening window)            30   60%     +$2.67       inconclusive (Fisher p vs R3 = 0.37)
─────────────────────────────────────────────────────────────────────────────────
TOTAL                                           285  51.2%   −$32.99
                                                              (manual sports bet additionally cost ~$11)
```

Canonical entries: [`docs/run-ledgers/kalshi-r1-r6-ledger.jsonl`](docs/run-ledgers/kalshi-r1-r6-ledger.jsonl).

The Fisher exact test on R3 (26W/13L) vs R6 (18W/12L) returned **p = 0.37** — i.e., the two profitable rounds are *not* statistically distinguishable. R3's +$9.48 was a high realization of the same modest expectancy R6 expressed. The strategy's true edge is much smaller than the R3 sample suggested.

---

## 2. Architecture (current)

```text
                       ┌──────────────────────────┐
                       │  Kalshi API (RSA-PSS)    │
                       └────────────┬─────────────┘
                                    │
                       ┌────────────▼─────────────┐
                       │   KalshiClient / Adapter │
                       └────────────┬─────────────┘
                                    │  markets, books, fills
   ┌────────────────────────────────┴───────────────────────────────┐
   │                          worker.ts scan loop                    │
   │                                                                 │
   │   ┌─────────────────┐                                           │
   │   │  Spot feeds     │  Binance.US REST  (fallback / sigma)      │
   │   │  + BRTI agg     │  Coinbase, Kraken, Bitstamp REST          │
   │   │                 │  → trimmed-mean BRTI + 1-min σ            │
   │   └────────┬────────┘                                           │
   │            │                                                    │
   │   ┌────────▼────────┐    ┌──────────────────────────────────┐   │
   │   │ fairValueArb    │    │ PerpBasisFeed (Kraken Futures)   │   │
   │   │ Φ(ln(S/K)/σ√τ)  │    │ PF_{ASSET}USD perp_mark + funding│   │
   │   └────────┬────────┘    └────────────┬─────────────────────┘   │
   │            │                          │                          │
   │            └───────────┬──────────────┘                          │
   │                        │                                         │
   │   ┌────────────────────▼──────────────────────────┐              │
   │   │       per-market scan-tick row                │              │
   │   │  side, p_gaussian, edge, σ, spot,             │              │
   │   │  perp_mark, basis_bps, funding_rate, books    │              │
   │   └────────┬───────────────────────────────┬──────┘              │
   │            │                               │                     │
   │            │   ┌───────────────────────────▼─────────┐           │
   │            │   │ ModelBakeoffLogger (LAYER 2)         │           │
   │            │   │ kalshi-model-bakeoff-shadow.jsonl    │           │
   │            │   └─────────────────────────────────────┘           │
   │            │                                                     │
   │            │   ┌───────────────────────────────────────┐         │
   │            │   │ SettlementValidator                    │         │
   │            │   │ kalshi-settlement-validation.jsonl    │         │
   │            │   │ BRTI vs Binance vs Kalshi label       │         │
   │            │   └───────────────────────────────────────┘         │
   │            │                                                     │
   │            ▼                                                     │
   │   ┌────────────────────────────────────────────┐                 │
   │   │ DustExecutor (gated; DISABLED in shadow)   │                 │
   │   │ defensibilityCheck → Kelly sizing → submit │                 │
   │   │ KALSHI_ALLOW_ORDERS=0 short-circuits       │                 │
   │   └────────────────────────────────────────────┘                 │
   └─────────────────────────────────────────────────────────────────┘

                 OFFLINE (no worker required):

   scripts/brier_bakeoff.py        ──→  analysis/brier/*.csv
   (joins validator + Layer 2 + filled state for prospective scoring)
```

Workspace is a pnpm monorepo:

```
apps/
  market-worker/      Scanner + executor (tsx). Currently shadow-only.
    src/kalshi/       Kalshi strategy, dust executor, settlement validator,
                      perpBasisFeed, modelBakeoffLogger
    src/brti/         Synthetic BRTI aggregator (Coinbase + Kraken + Bitstamp)
    scripts/          brier_bakeoff.py — Layer-1 analysis
  web/                Next.js read-only operator dashboard
packages/
  kalshi-client/      REST + RSA-PSS auth + venue-neutral adapter
  types/              Shared venue-neutral interfaces
docs/
  run-ledgers/        Sanitized per-round PnL summaries (committed)
  research/           Notes (gitignored)
analysis/
  brier/              Derived bakeoff outputs (gitignored)
```

---

## 3. The deployed model (frozen)

For a Kalshi binary that pays $1 if `S_T ≥ K`, the worker computes:

```math
\hat p_{\text{YES}}(t) = \Phi\!\Big(\tfrac{\ln\,S(t)/K}{\sigma_{\text{ann}}\sqrt{\tau}}\Big),
\qquad \tau = \tfrac{\text{close\_time}-\text{now}}{365 \cdot 86400}
```

Edge / threshold:

```math
\text{edge}_{\text{YES}} = \hat p_{\text{YES}} - \text{ask}_{\text{yes}},
\qquad
\text{thr} = \tfrac{1}{2}(\text{ask}-\text{bid}) + \text{safety} + \text{edge\_floor}
```

This is the **baseline** model. Every test below scores transforms or feature-augmentations of it against the same labels.

### Per-asset calibration (deployed, low-impact)

```math
b_d = \tfrac{1}{N_d}\!\!\!\sum_{i:\,\text{series}=d}\!\!\big(\mathbb{1}\{\text{YES}_i\}-\hat p_{\text{YES},i}\big),
\qquad
\hat p_{\text{corr}} = \mathrm{clamp}\big(\hat p_{\text{YES}}+\alpha b_d,\,0.05,\,0.95\big)
```

`α = KALSHI_CALIBRATION_ALPHA` defaults to 0.5. Bias table is regenerated every 5 min by `scripts/compute_calibration.py` from settled trades and hot-reloaded by the worker.

### Fractional Kelly sizing

For a binary at ask `A`, model win-probability `p`:

```math
f^{*} = \frac{p-A}{1-A} = \frac{\text{edge}}{1-A},
\qquad
\text{notional} = \min\!\big(\text{max\_notional},\,B \cdot k \cdot f^{*}\big),
\qquad
\text{contracts}=\lfloor \text{notional}/A\rfloor
```

R4 lesson: bumping `B` from $50 → $250 mid-round drove the catastrophic loss. Kelly bumps must be validated by a full clean round at the new bankroll before applying; **never bump mid-round**.

---

## 4. The new calculus: Brier bakeoff (this is the unlock)

The hypothesis "the strategy has edge once we calibrate fair_yes" was tested directly and rejected. The right diagnostic isn't subjective; it's a Brier walk-forward against held-out settlements.

### 4.1 Brier score and skill

For a binary outcome `y ∈ {0,1}` with predicted probability `p`:

```math
\mathrm{Brier}(p,y) = (p-y)^2
\qquad
\overline{\mathrm{Brier}} = \tfrac{1}{N}\sum_i (p_i - y_i)^2
```

The reference is climatology — predict the base rate `\bar y` for every market:

```math
\mathrm{Brier}_{\text{clim}} = \bar y\,(1-\bar y)
```

Brier skill score:

```math
\mathrm{BSS} = 1 - \frac{\overline{\mathrm{Brier}}_{\text{model}}}{\mathrm{Brier}_{\text{clim}}}
\qquad
\text{BSS > 0 = beats baseline}
```

### 4.2 Reliability diagram

Bucket predictions by `p` into deciles. For each bucket compute the mean prediction and the empirical hit rate. Gap = mean_p − actual. Well-calibrated models have gap ≈ 0 in every bucket.

The deployed Gaussian baseline on filled trades:

```text
p bucket       n    mean_p   actual    gap     bucket_brier   PnL
[0.40,0.50)   87    0.451    0.460    -0.009    0.248         +$7.41   well-cal, profitable
[0.50,0.60)   53    0.547    0.585    -0.038    0.239         -$15.50  well-cal, BUT loses (spread bites)
[0.60,0.70)   57    0.642    0.544    +0.098    0.255         -$4.23   overconfident
[0.70,0.80)   19    0.740    0.474    +0.266    0.315         -$9.45   MASSIVELY overconfident
```

The smoking gun: high-`p` buckets carry massive miscalibration. Even where the model IS well-calibrated (0.5-0.6), the strategy loses money because edges aren't large enough vs spread. **Calibration is necessary but not sufficient — actual edge is the binding constraint.**

### 4.3 Universes scored SEPARATELY

A frozen pitfall the Brier baseline made obvious:

```math
\mathrm{Brier}_{\text{all\_decisions}} \;\ll\; \mathrm{Brier}_{\text{filled}}
```

All-decisions Brier looks excellent (0.04 — strong skill) because most rows are deep-OTM markets where the model is confident and right. Filled-trade Brier is ~0.25 (coin-flip) because the executor only enters marginal markets where the model has no real edge. **Scoring both is mandatory — any analysis that fails to separate them hides the selection-effect pathology.**

### 4.4 Candidate model transforms (M0 – M3)

| Model | Form | Purpose |
|---|---|---|
| **M0** Gaussian/BRTI | `p_gaussian` (raw) | Baseline. What the worker actually emits. |
| **M1** Clipped | `clip(p_gaussian, [lo,hi])` | Does tail-trimming alone fix overconfidence? |
| **M2** Logistic-calibrated | `σ(β₀ + β₁·logit(p_gaussian))` | Does monotonic recalibration fix it? |
| **M3** Student-t / temperature | `T_ν(α + β·Φ⁻¹(p_gaussian))` | Are heavy tails the real issue? |

Recover the standardized z from the baseline probability:

```math
z = \Phi^{-1}(p_{\text{gaussian}}),
\qquad
p_{\text{student-t}}(\alpha,\beta,\nu) = T_\nu(\alpha + \beta z)
```

Grid:

```text
ν      : 2, 3, 4, 5, 7, 10, 15, 30
β      : 0.25, 0.40, 0.55, 0.70, 0.85, 1.00
α      : −0.20, −0.10, 0.00, +0.10, +0.20
```

Pick the tuple with lowest **out-of-sample** Brier on a held-out fold (never in-sample).

### 4.5 Walk-forward validation

Random train/test splits leak time regimes. We fold by chronological close_time:

```text
Fold 1: train first 50%, test next 10%
Fold 2: train first 60%, test next 10%
Fold 3: train first 70%, test next 10%
Fold 4: train first 80%, test final 20%
```

Each model is refit on each train slice and scored on its disjoint test slice. Final reported Brier is the mean across folds.

### 4.6 Layer-1 result (frozen evidence, n=285 filled)

```text
filled universe (walk-forward Brier, sorted ascending):
  p_clip_0.35_0.65       0.2471   ← best
  p_student_t            0.2473
  p_clip_0.30_0.70       0.2488
  p_logistic             0.2490
  p_gaussian             0.2497   ← raw baseline
  
all_decisions universe (n=512):
  p_logistic             0.0279   ← 16% Brier skill improvement over Gaussian
  p_student_t            0.0320
  p_gaussian             0.0332
```

**No model passes the gate on the filled universe.** Best skill 0.93% (Student-t walk-forward, n=285) — required ≥5%. The same models on the all-decisions universe demonstrate the calibration tooling works; it just can't add information the executor doesn't already extract.

### 4.7 The decision gate

A new model is allowed to drive live trading only if **all three** clear:

```math
\overline{\mathrm{Brier}}_{\text{filled}}^{\text{model}} < 0.250
\qquad
\mathrm{BSS}_{\text{vs Gaussian}}^{\text{filled}} \ge 0.05
\qquad
\text{simulated edge per contract} \ge +2.5\text{¢}
```

After fees (taker fee at $0.50 strikes ≈ 2¢/contract), the edge gate guarantees profitability after the round-trip cost.

---

## 5. Layer 1: offline harness

```bash
python3 apps/market-worker/scripts/brier_bakeoff.py
```

Inputs:

```text
logs/kalshi-settlement-validation.jsonl   (label source)
logs/kalshi-dust-state.json               (filled trades)
logs/kalshi-model-bakeoff-shadow.jsonl    (Layer-2 features, if present)
```

Outputs (`analysis/brier/`, gitignored — regenerate per run):

```text
brier_summary.json                  topline metrics
brier_summary.csv                   in-sample Brier per model per universe
reliability_all_decisions.csv       10-bucket reliability table, validator
reliability_filled.csv              10-bucket reliability table, filled
bakeoff_walk_forward.csv            per-fold per-model per-universe Brier
bakeoff_walk_forward_summary.csv    aggregated walk-forward
bakeoff_by_asset.csv                Brier per asset
bakeoff_by_hour.csv                 Brier per UTC hour
```

Adding new candidate transforms is straightforward — implement a `fit_X(train)` and `apply_X(model, df)` pair, append it to the walk-forward loop. The script is deliberately read-only with respect to the worker.

---

## 6. Layer 2: shadow bakeoff logger

`apps/market-worker/src/kalshi/modelBakeoffLogger.ts` writes one row per market scan-tick to `logs/kalshi-model-bakeoff-shadow.jsonl` regardless of `KALSHI_DUST_ENABLED`. Each row captures the Gaussian/BRTI prediction PLUS any candidate features computed at decision time.

### 6.1 Schema v1 (current)

```json
{
  "schema_version": 1,
  "ts": "2026-05-18T01:16:13.631Z",
  "ticker": "KXBTC15M-26MAY172130-30",
  "series": "KXBTC15M",
  "asset": "BTC",
  "strike": 77097.37,
  "close_time": "2026-05-18T01:30:00Z",
  "secs_to_close": 826.4,
  "side_gaussian": "NO",
  "p_gaussian": 0.1996,
  "edge_gaussian": 0.0704,
  "best_yes_bid": 0.27, "best_yes_ask": 0.28,
  "best_no_bid": 0.72,  "best_no_ask": 0.73,
  "spot": 76945.50, "spot_source": "brti",
  "sigma_annual": 0.4244, "sigma_source": "binance",
  "perp_mark": 76936.70, "perp_index": 76950.06,
  "perp_age_ms": 2950,
  "basis_mid": -8.80, "basis_bps": -1.14,
  "funding_rate": -0.2146
}
```

Settlement is joined out-of-band by ticker against `kalshi-settlement-validation.jsonl`. This guarantees no leakage — the model probabilities were written before the settlement was known.

### 6.2 Feature #1: spot-perp basis (Kraken Futures)

`apps/market-worker/src/kalshi/perpBasisFeed.ts` polls the Kraken Futures REST endpoint `/derivatives/api/v3/tickers` at 3-second cadence:

```math
\text{perp\_mark}_t, \;\text{perp\_index}_t, \;\text{funding\_rate}_t \;\leftarrow\; \text{Kraken PF\_\{ASSET\}USD}
```

Basis is computed against the BRTI spot at scan time:

```math
\text{basis\_mid}_t = \text{perp\_mark}_t - S^{\text{BRTI}}_t
\qquad
\text{basis\_bps}_t = 10\,000 \cdot \frac{\text{basis\_mid}_t}{S^{\text{BRTI}}_t}
```

Kraken Futures is used because it is US-licensed and accessible from US IPs; Bybit, Binance Global futures, and Coinbase Advanced perps are either blocked or require auth. Override the venue with `PERP_FEED_REST` and `PERP_FEED_PATH` env vars if needed.

### 6.3 Augmented model

A new candidate model in `brier_bakeoff.py`:

```math
p_{\text{logistic+basis}} = \sigma\big(\beta_0 + \beta_1\,\mathrm{logit}(p_{\text{gauss}}) + \beta_2\,\text{basis\_bps} + \beta_3\,\text{funding\_rate}\big)
```

Fit walk-forward on the joined `shadow_with_basis` universe. The hypothesis being tested: does basis predict the *direction* of settlement bias the Gaussian model misses?

### 6.4 Why basis first, not OFI

| Feature | Cost | Risk |
|---|---|---|
| **Spot-perp basis** | ~2-3 days impl (REST poll, single venue) | Scalar; easy to debug; covers all 9 universe assets |
| **OFI top-5** | ~1-2 weeks (WebSocket migration + L2 normalization across Coinbase/Kraken/Bitstamp) | Multi-venue, multi-level; more failure modes |

Basis is the cheaper first test of whether *new information* — not new functional form — can clear the filled-trade Brier gate. If basis fails to clear the gate, OFI is next. If both fail, the strategy probably doesn't have edge in this market.

---

## 7. Falsified directions (do not revisit without new evidence)

- **Student-t / fat-tailed CDF.** Walk-forward improvement over Gaussian on filled-trade universe is < 1%. Best ν is 100 on the all-decisions sample (effectively Gaussian); ν=2 on the filled sample is in-sample noise that doesn't survive walk-forward. The model's miscalibration is not tail-fatness.
- **Isotonic / logistic post-hoc calibration.** Trained on all-decisions, the calibration relationship is *non-monotonic* between universes — applying it makes filled-trade Brier WORSE (+11%). The calibration must be feature-conditional, not global.
- **Mid-round Kelly bump.** R4 lost −$28 in 21 trades after bumping Kelly $50 → $250 mid-round. Methodological rule: Kelly bumps require a full clean round at the new bankroll before applying.
- **"13:55–17:05 UTC initially" time-gate (original §7 plan).** Empirically that window is the *losing* window. R5 ran in it and went to 33% win rate. R3+R6 evening windows are profitable; the right gate is approximately 18:00–04:00 UTC, not the original spec.
- **Pure time-gating alone.** R6 was run in the R3-equivalent window with the R3 config and finished only +$2.67 (INCONCLUSIVE per the gate). Time-of-day helps but does not unlock the strategy on its own. Must be combined with new features.

---

## 8. Lessons from R1 → R6 (load-bearing)

1. **Per-asset calibration biases at n < 30 are noise.** The R3 +$9.48 win rate (70%) and R6 +$2.67 win rate (60%) are statistically indistinguishable (Fisher p = 0.37). R3 was a sample-variance peak above the true expectancy.
2. **Hard-stop has overshoot risk at high Kelly.** R4 settled to cum=−$18.59 even though the cap was −$15. The check happens at submission time, not at outcome time; multiple concurrent in-flight orders settling against can blow through the cap.
3. **Backoff threshold ($8 over 3 consecutive losses) catches shock streaks but misses slow bleeds.** R5 lost −$5.43 in 6 small-size consecutive losses that never tripped the cap.
4. **Selection effect dominates.** The same model that has 86% Brier skill on broad markets has 0% skill on the marginal markets the executor selects. Calibration alone can't recover that information.
5. **"Two-book" hygiene.** Discretionary bets (a manual sports bet on PSG vs Paris FC cost ~$11) contaminate strategy-balance accounting if mixed in the same account. Either a separate account or a fixed strategy-budget envelope is required for clean evaluation.
6. **The validator is the most valuable infrastructure artifact.** `SettlementValidator` reads BRTI and Binance settlement-window means against Kalshi's actual print. At n=188 disagreements the BRTI advantage is decisive (p=10⁻³⁰) — reusable for any future Kalshi crypto strategy independent of trading layer.

---

## 9. Operational state

```text
Live trading:           PAUSED (no live orders since 2026-05-17)
Shadow worker:          alive (KALSHI_ALLOW_ORDERS=0, AUTO_SUBMIT=0, DUST_ENABLED=0)
                        accumulating settlement-validation + Layer 2 rows
Kalshi balance:         ~$18 (after R6 close)
                        Hard-stop math: any live retest needs ≤ $8 max-loss budget
                        otherwise risk-of-ruin is meaningful
Round ledger:           docs/run-ledgers/kalshi-r1-r6-ledger.jsonl
Worker uptime today:    see logs/shadow-run-*.log
```

Live re-arm prerequisites (all three):

```math
\overline{\mathrm{Brier}}^{\text{filled}}_{\text{candidate}} < 0.250
\quad\wedge\quad
\mathrm{BSS}^{\text{filled}}_{\text{vs Gaussian}} \ge 0.05
\quad\wedge\quad
\text{simulated edge} \ge +2.5\text{¢/contract}
```

—evaluated on a candidate model trained on the *filled subset* with at least the Layer 2 basis feature, walk-forward, no in-sample leakage.

---

## 10. Configuration reference

Env vars on the worker. Defaults shown; live trading flags are intentionally OFF.

```text
# === Safety switches (live retest only) ===
KALSHI_ALLOW_ORDERS                  0      # 1 = LIVE submits permitted
KALSHI_AUTO_SUBMIT                   0      # 1 = auto-confirm + submit
KALSHI_DUST_ENABLED                  0      # 1 = create candidates that mutate state

# === Strategy ===
KALSHI_SIGMA_MULTIPLIER             1.0
KALSHI_MIN_Z_DISTANCE               0.0
KALSHI_CALIBRATION_ALPHA            0.5
KALSHI_CALIBRATION_INTERVAL_MS    300000

# === Defensibility filter ===
KALSHI_DEF_EDGE_MIN                 0.02
KALSHI_DEF_EDGE_MAX                 0.10
KALSHI_DEF_PRICE_MIN                0.20
KALSHI_DEF_PRICE_MAX                0.80
KALSHI_DEF_SPREAD_MAX               0.10
KALSHI_DEF_SIGMA_MAX             Infinity   # set to 0.40 to enable R2.C cap
KALSHI_DEF_YES_MIN_EDGE          Infinity   # set to 0.15 to enable R3.A floor
KALSHI_DEF_CONTRARIAN_BID           0.60
KALSHI_DEF_CONTRARIAN_EDGE_MIN      0.15
KALSHI_DEF_MIN_SECS_TO_CLOSE        90

# === Dust executor ===
KALSHI_DUST_MAX_NOTIONAL_USD        1
KALSHI_DUST_MAX_TRADES              5
KALSHI_DUST_MAX_AGGREGATE_USD       3
KALSHI_DUST_MAX_SAME_SIDE           2
KALSHI_DUST_BACKOFF_STREAK          3
KALSHI_DUST_BACKOFF_LOSS_USD        3
KALSHI_DUST_BACKOFF_SEC             300
KALSHI_DUST_HARD_STOP_PNL_USD     -15
KALSHI_DUST_CANDIDATE_TTL_SEC       75
KALSHI_DUST_MIN_ORDER_SIZE          1
KALSHI_DUST_MANUAL_CONFIRM_FIRST_N  3

# === Kelly sizing ===
KALSHI_DUST_USE_KELLY               1
KALSHI_DUST_KELLY_FRACTION          0.25
KALSHI_DUST_KELLY_BANKROLL          20

# === Spot/perp feed overrides ===
SPOT_FEED_REST              https://api.binance.us
PERP_FEED_REST              https://futures.kraken.com
PERP_FEED_PATH              /derivatives/api/v3/tickers
```

Filters added in R2 / R3 (default Infinity, opt-in):

| Env var | Effect | Justification |
|---|---|---|
| `KALSHI_DEF_SIGMA_MAX=0.40` | reject candidates with σ_annual ≥ 0.40 | R2.C — high-σ tickers (HYPE, DOGE) bled |
| `KALSHI_DEF_YES_MIN_EDGE=0.15` | reject YES-side candidates with edge < 0.15 | R3.A — YES side biased high; 3W/6L cross-round |

---

## 11. Running locally

```bash
# Install
pnpm install

# Shadow worker (recommended default — no live exposure)
cd apps/market-worker
KALSHI_ALLOW_ORDERS=0 KALSHI_AUTO_SUBMIT=0 KALSHI_DUST_ENABLED=0 \
  pnpm exec tsx src/kalshi/worker.ts

# Run Brier bakeoff over current logs
cd /path/to/repo-root
python3 apps/market-worker/scripts/brier_bakeoff.py
# outputs under analysis/brier/ (gitignored, regenerate per run)

# Smoke-test BRTI aggregator only
cd apps/market-worker
pnpm exec tsx src/brti/smoke_test.ts

# Web dashboard
cd apps/web
pnpm dev   # http://localhost:3000
```

**Do not launch live trading without first:**
1. Running `brier_bakeoff.py` on the current shadow+filled corpus.
2. Confirming the candidate model clears the three-criteria gate.
3. Setting a hard-stop ≤ 50% of remaining bankroll.

---

## 12. References (load-bearing)

Empirically validated by this session:

1. **Le, N. A. (2026).** *Decomposing Crowd Wisdom: Domain-Specific Calibration Dynamics in Prediction Markets.* arXiv:2602.19520. — Kalshi crypto at 0-1h is well calibrated (slope 0.99). Confirmed by our session's calibration buckets near 0.5.
2. **Mohanty, H., Krishnamachari, B. (2026).** *Do Prediction Markets Forecast Cryptocurrency Volatility?* arXiv:2604.01431. — KXFED/KXCPI prices carry crypto-vol information.
3. **Mostafa, H., Shastri, O., Lee, D. (2026).** *TimeSeek: Temporal Reliability of Agentic Forecasters.* arXiv:2604.04220. — Model competitiveness deteriorates near resolution. The 15-min-binary in its final 60s is the worst possible window — reflected directly in our R6 last-minute σ explosion that paralyzed the candidate filter.

Pointed at by the diagnostic, not yet operationalized:

4. **Gatheral, J., Jaisson, T., Rosenbaum, M. (2018).** *Volatility is Rough.* — Log-vol behaves as fBm with H≈0.1. Theoretical motivation for the near-strike gamma trap pattern in our reliability buckets.
5. **Giorgio, G., Pacchiarotti, B., Pigato, P. (2022).** *Short-Time Asymptotics for Non-Self-Similar Stochastic Volatility Models.* arXiv:2204.10103. — Short-maturity implied vol skew under rough vol — directly applicable to 15-min binaries.
6. **Hyong-Chol, O., Choe, D-S. (2019).** *Pricing Formulae of Power Binary and Normal Distribution Standard Options.* arXiv:1903.04106. — Discrete geometric Asian binary closed-form; relevant to Kalshi's 60-second TWAP settlement (vs the point-settlement assumed by Φ).

Methodological:

7. **Galekwa, R. et al. (2026).** *Toward Sports Betting as a Financial Asset.* IEEE Access. — KL-divergence-penalized Kelly. Reduces ruin probability 78% → < 2%.
8. **Nayar, R. et al. (2026).** *Topological Risk Parity.* arXiv:2604.16773. — Tree-based portfolio construction for correlated-crisis clusters (mitigation for the R4 "7 simultaneous markets become one bet" failure mode).

---

## 13. Execution-side calculus: maker-replay harness (2026-05-26, new path)

A research thread **orthogonal to §4-6.** Where the Brier bakeoff asks "what is the right probability for `P(YES)` at decision time?", this harness asks "what is the realized PnL of a passive maker quote, accounting for queue position, adverse selection, and settlement drift?"

The harness is **read-only**. It consumes a 30 h Kalshi WebSocket capture (orderbook snapshots + deltas + trades; ~16.7 M messages over 875 markets) and simulates hypothetical resting maker quotes against the historical tape. No live orders, no worker changes, no signal-model code touched.

### 13.1 Kalshi orderbook semantics

Kalshi's WS publishes only **bid books** on each side. There are no explicit asks; the ask is derived via no-arb from the opposite side's best bid:

```math
\text{best\_yes\_ask} \;=\; 1 - \text{best\_no\_bid}
\qquad
\text{best\_no\_ask} \;=\; 1 - \text{best\_yes\_bid}
```

The YES-mid is then:

```math
\text{mid}_{\text{yes}}(t) \;=\; \tfrac{1}{2}\!\left(\text{best\_yes\_bid}(t)\;+\;1 - \text{best\_no\_bid}(t)\right)
```

When either side has no resting bid, `mid_yes` is undefined and the reconstructor returns `null` (it refuses to synthesize a `yes_ask = 1.000` ceiling).

### 13.2 Book reconstruction

Per market ticker, two integer-keyed maps `(price\_ticks → size)` track the yes-bid and no-bid stacks. Three WS event types update the state:

| event | effect |
|---|---|
| Snapshot **with levels** (`yes_dollars_fp` + `no_dollars_fp`) | Replace both stacks. Fired on initial subscribe and on WS reconnect re-sync. |
| Snapshot **header-only** (`{market_ticker, market_id}`) | Mark market **terminated**; halt further delta application. |
| Delta (`side, price_dollars, delta_fp`) | `size ← max(0,\;size + \texttt{delta\_fp})`. Level removed when `size = 0`. |

Validation against the Kalshi ticker channel mid at coincident server-side timestamps:

```math
\Pr\!\big[\,\text{recon\_mid}(t) = \text{ticker\_mid}(t)\,\big] \;\;\approx\;\; 92.4\,\%-94.3\,\%
```

The non-matching ~6% are one-side-empty deep-ITM windows where the reconstructor returns null and the ticker synthesizes the ceiling. Settlement-PnL **decomposition identity** (§13.5) holds to floating-point noise — verified `\lvert\text{residual}\rvert \le 1.4 \times 10^{-14}` ¢ across 5 058 quotes. See [`kalshi-book-reconstructor-validation-2026-05-26.md`](docs/research/kalshi-book-reconstructor-validation-2026-05-26.md).

### 13.3 Queue position model (FIFO)

A hypothetical resting maker quote at `(side,\,price,\,size,\,t_{\text{post}})` competes with existing depth `D_0` at that price level. The queue is FIFO; initial queue position depends on the assumption:

```math
q_0 \;=\; \alpha \cdot D_0, \qquad
\alpha \in \{\,0,\,\tfrac{1}{2},\,1\,\}
\quad\text{for}\quad
\text{front\_of\_queue} \,/\,\text{depth\_50} \,/\,\text{back\_of\_queue}
```

Each matching trade `T_n` at our price level reduces the queue:

```math
q_{n+1} \;=\; \max\!\big(0,\;q_n - T_n\big)
```

The quote fills when `q_n` reaches 0 AND the residual `T_n - q_n` covers our remaining size. v1 does **not** model cancels-ahead (deltas with `\Delta_{fp} < 0` that aren't trade-induced) — this makes the model **conservative** (over-estimates queue obstruction).

Fill matching by side:

| posted side | filled by trade where | maker effectively buys |
|---|---|---|
| YES-bid at `P_y` | `taker_outcome_side = "no"` AND `trade.yes_price = P_y` | 1 YES at `P_y` |
| NO-bid at `P_n` | `taker_outcome_side = "yes"` AND `trade.no_price = P_n` | 1 NO at `P_n` |

All four sanity checks pass on the 30 h sample — fill rate monotonically decreases behind best, tighter queue assumption lowers fill rate, maker captures positive markout at the touch, and conditional markout degrades as the quote moves behind best. See [`kalshi-queue-model-validation-2026-05-26.md`](docs/research/kalshi-queue-model-validation-2026-05-26.md).

### 13.4 Settlement PnL

For a YES-bid filled at price `P_y`, settlement `S \in [0,1]` (1 if YES wins, 0 if NO; continuous proxy from late-market mid otherwise), with fill fraction `F`:

```math
\text{PnL}_{\text{settle}}^{\text{yes-bid}} \;=\; (S - P_y) \cdot F
```

Mirror for NO-bid filled at `P_n`:

```math
\text{PnL}_{\text{settle}}^{\text{no-bid}} \;=\; \big((1-S) - P_n\big) \cdot F
```

### 13.5 Adverse-selection decomposition

Per-quote settlement PnL decomposes **exactly** into three signed components for any horizon `H` (YES-bid form shown; NO-bid mirrors):

```math
\boxed{\;\;
\text{PnL}_{\text{settle}}
\;=\;
\underbrace{(M_{\text{fill}} - P_y)}_{\text{spread captured at fill}}
\;+\;
\underbrace{(M_{\text{fill}+H} - M_{\text{fill}})}_{\text{adverse selection at }H}
\;+\;
\underbrace{(S - M_{\text{fill}+H})}_{\text{residual drift to settle}}
\;\;}
```

where `M_t \;\equiv\; \text{mid}_{\text{yes}}(t)`. The identity holds by telescoping; it is verified to `\le 1.4 \times 10^{-14}` ¢ in code.

For the dumb two-sided `BTC_TOUCH_DEPTH50` policy at `depth_50`, conditional on a fill, the empirical means (in cents per filled quote, in-sample 30 h):

| component | mean (¢/filled) |
|---|---:|
| spread captured | −0.316 |
| adv selection @ 1 s | −0.360 |
| adv selection @ 5 s | −0.587 |
| adv selection @ 15 s | −0.475 |
| adv selection @ 30 s | −0.239 |
| adv selection @ 60 s | **+0.474** |
| residual (60 s → settle) | +0.497 |
| **settlement PnL** | **+0.655** |

**Reading the row.** "Spread captured" is negative because by the time a `depth_50` queue position is reached, the historical mid has already moved against us by ~half a tick (pre-fill drift). Short-horizon adverse selection is U-shaped — most negative at 5-15 s, then **mean-reverts** by 60 s. Residual drift to settlement compounds favorably. Net is positive per filled — *conditional on filling*.

### 13.6 Markout EV vs settlement EV — why they diverge

A maker has two natural EV measures conditional on fill:

```math
\mu_H \;=\; \mathbb{E}\!\left[\,M_{\text{fill}+H} - P\,\big|\,\text{filled}\,\right]
\qquad
\nu \;=\; \mathbb{E}\!\left[\,S - P\,\big|\,\text{filled}\,\right]
```

`\mu_H` is the **rolling adverse-selection signal** at horizon `H`; `\nu` is the **realized P&L** at settlement. In the 30 h in-sample for `BTC_TOUCH_DEPTH50`:

```math
\mu_{30\text{s}} \;\approx\; -0.41\,\text{¢/posted}
\qquad
\nu \;\approx\; +0.35\,\text{¢/posted}
```

They disagree in sign. Filled quotes are **selected** on "taker willing to cross" — that selection enriches for mildly-informed flow at the 30 s horizon, but the information leak is shallow and mean-reverts over the remaining 5-10 min of market life. **A maker's account cares about `\nu`, not `\mu_H`.** The earlier pass-criteria using `\mu_H` were measuring the wrong quantity; settlement-based EV is the canonical PnL metric here.

### 13.7 The verdict on dumb two-sided BTC

The adverse-selection scorer bucketed the decomposition by (TTE × ToD × side × queue × fill-latency × moneyness) and surfaced three structural concentrations:

| dimension | concentration |
|---|---|
| **side** | YES-bid alone **+0.91¢/posted**; NO-bid alone **−0.22¢/posted** (net drag) |
| **TTE bucket** | Removing the 6-9 min TTE bucket flips total EV to **−0.06¢/posted** |
| **time of day** | UTC 00-08 Z (Asia + early Europe) carries the edge; 08-20 Z (US daytime) is net negative |
| **fill latency** | U-shaped: <1 s wins (+1.77¢/filled), 1-30 s adversely selected (−1.1 to −1.4¢), >30 s wins big (+12 to +27¢/filled) |

Two of four robustness pass gates fail: (i) NO-bid side is unprofitable, (ii) leave-best-TTE-bucket-out flips total negative. Per the agreed protocol this is a **STOP** before building any maker replay on the dumb policy. See [`kalshi-adverse-selection-scorer-2026-05-26.md`](docs/research/kalshi-adverse-selection-scorer-2026-05-26.md).

### 13.8 Pre-registered refined policy `BTC_YES_LATE_ASIA_v1`

A refined policy is **pre-registered** in [`kalshi-policy-preregistration-btc-yes-late-asia-v1-2026-05-26.md`](docs/research/kalshi-policy-preregistration-btc-yes-late-asia-v1-2026-05-26.md) and frozen in [`apps/data-collector/src/replay/btcYesLateAsiaV1.ts`](apps/data-collector/src/replay/btcYesLateAsiaV1.ts):

| filter | value |
|---|---|
| series | `KXBTC15M` |
| side | YES-bid only |
| price | at `best_yes_bid` (the touch) |
| size | 1 contract |
| queue assumption | `depth_fraction_50%` |
| TTE filter | `\text{tte}_{\text{min}} \ge 6\,\text{min}` |
| UTC-hour filter | `h_{\text{utc}} \in [20,24) \cup [0,8)` |
| cancel | none — hold to settlement |
| anchor cadence | every 60 s |

**Operator commitment:** no filter, threshold, or rule is modified between this pre-registration and the holdout. If the holdout fails, v1 is rejected as a whole; a future v2 requires its own fresh pre-registration on a *third* sample.

#### Holdout pass gates (identical between in-sample and fresh data)

For settlement EV per posted `\nu_{\text{posted}}`, leave-one-out variants `\nu_{\text{posted}}^{(-b)}`:

```math
\begin{aligned}
\text{(1)}\quad & \nu_{\text{posted}} \;>\; 0 \\
\text{(2)}\quad & \mathbb{E}[\,S - P \,\big|\, \text{filled}\,] \;>\; 0 \\
\text{(3)}\quad & \forall\,b \in \{\text{6-9},\,\text{9-12},\,\text{12-15}\}\;\text{min}: \quad \nu_{\text{posted}}^{(-b)} \;>\; 0 \\
\text{(4)}\quad & \forall\,b \in \{\text{20-24Z},\,\text{00-04Z},\,\text{04-08Z}\}: \quad \nu_{\text{posted}}^{(-b)} \;>\; 0 \\
\text{(5)}\quad & \max_{\text{market}}\;\frac{\lvert\sum \text{PnL}_{\text{market}}\rvert}{\sum_i \lvert\text{PnL}_i\rvert} \;\le\; 0.25 \\
\text{(6)}\quad & \max_{2\text{h window}}\;\frac{\lvert\sum \text{PnL}_{w}\rvert}{\sum_i \lvert\text{PnL}_i\rvert} \;\le\; 0.40 \\
\text{(7)}\quad & \nu^{\text{YES-side}}_{\text{posted}} \;>\; 0 \quad\text{(trivial; v1 is YES-only)}
\end{aligned}
```

#### In-sample exploratory result (NOT validation)

| metric | value |
|---|---:|
| posted | 362 |
| filled | 194 (53.6 %) |
| **settlement EV per posted** | **+\$0.0200** (= +2.00 ¢) |
| settlement EV per filled | +\$0.0377 (= +3.77 ¢) |

Gates 1–4, 6–7 pass in-sample. **Gate 5 fails in-sample at 58.7 %** — a single 15-minute market (`KXBTC15M-26MAY252115-15`) drove the majority of in-sample PnL. This anchors the correct prior on the holdout: expect significant shrinkage from selection optimism, and watch single-market concentration as the load-bearing test of whether v1 has actual edge or merely lucked into one event. **Per the pre-registration, none of these results are used to modify the policy.**

### 13.9 What's next

- **Holdout collection** in a calendar week ≥ 2026-06-02, distinct from the in-sample window. Minimum 30 h, preferred 3-7 days. Same `apps/data-collector/` codebase, same schema; no worker, no live orders.
- **Re-run `btcYesLateAsiaV1.ts` unchanged** against the new log dir. Binary verdict via the 7 gates above.
- If v1 **passes** all 7 gates: a tiny maker-only canary may be discussed (size ≪ R1's Kelly base; explicit hard-stop; subject to the same two-book hygiene as §8.5).
- If v1 **fails**: v1 rejected. Any v2 requires a new pre-registration on a *third* fresh sample; testing a v2 derived from the v1 holdout would repeat the selection-bias trap.

The signal-model path (§4-6) and the execution-model path (§13) are **disjoint**: no shared code, no shared falsifiers, no shared pass gates. They MUST stay independent — running the maker-replay scorer on the same tape that birthed it is the exact failure pre-registration prevents.

### 13.10 Module map

| file | role |
|---|---|
| [`apps/data-collector/src/index.ts`](apps/data-collector/src/index.ts) | Kalshi WS collector (read-only). Persists hourly-gzipped JSONL. |
| [`apps/data-collector/src/replay/bookReconstructor.ts`](apps/data-collector/src/replay/bookReconstructor.ts) | Two-sided book reconstruction primitive (§13.1, 13.2). |
| [`apps/data-collector/src/replay/queueModel.ts`](apps/data-collector/src/replay/queueModel.ts) | FIFO queue simulator with front/depth_50/back assumptions (§13.3). |
| [`apps/data-collector/src/replay/passiveQuoteSimulator.ts`](apps/data-collector/src/replay/passiveQuoteSimulator.ts) | `BTC_TOUCH_DEPTH50` two-sided maker over all anchors. |
| [`apps/data-collector/src/replay/adverseSelectionScorer.ts`](apps/data-collector/src/replay/adverseSelectionScorer.ts) | Per-quote decomposition + bucketed verdict (§13.5, 13.7). |
| [`apps/data-collector/src/replay/btcYesLateAsiaV1.ts`](apps/data-collector/src/replay/btcYesLateAsiaV1.ts) | Frozen pre-registered policy (§13.8). |
| [`apps/data-collector/src/replay/validateMarkouts.ts`](apps/data-collector/src/replay/validateMarkouts.ts) | Reconstructor validation against ticker channel. |
| [`apps/data-collector/src/replay/validateQueueModel.ts`](apps/data-collector/src/replay/validateQueueModel.ts) | Queue model sanity checks. |

Validation docs under [`docs/research/kalshi-*.md`](docs/research/) (8 files): adequacy, reconstructor, queue model, passive policy, decomposition, pre-registration.

### 13.11 Non-holdout prerun shakeout (2026-05-27)

A second collector run was started 2026-05-26T22:38Z targeting the 30-hour window for the §13.8 holdout. It was halted manually at 2026-05-27T09:34Z (elapsed 9 h 32 m, 10 of the required 30 UTC hour buckets). The window does **not** satisfy `continuous_holdout_eligible` per the §13 protocol — only 33% of the required duration.

Despite the protocol violation, the frozen replay and $25 capped replay were run against the partial window as a non-holdout pipeline shakeout, and the maker order/cancel code path was exercised in dry-run mode with `KALSHI_ALLOW_ORDERS=0`. Results recorded for the historical record only — **not** for any update of the pre-registered policy:

| step | result |
|---|---|
| Frozen `BTC_YES_LATE_ASIA_v1` replay (282 posted, 142 filled) | 9 of 7 gates failed; EV per posted = −1.5¢; total settlement PnL = **−$4.26** |
| Gate 5 top-1 market share | **94.5%** (vs ≤ 25% gate) — `KXBTC15M-26MAY262200-00` dominated |
| Gate 6 top-1 2h window share | **122.0%** (vs ≤ 40% gate) — one 2h block exceeded the absolute sum |
| $25 capped replay | same −$4.26 realized PnL; **max drawdown $12.64 (50.6% of $25 bankroll)**; caps not binding (29.1% utilization) |
| Maker order/cancel dry-run (30 min, ALLOW_ORDERS=0) | plumbing validated; 20 `pending_confirm`, 20 TTL-expired, 26 rejections (Kelly-size-0, same-side cap, series-in-flight); 0 HTTP requests to `/kalshi/dust/submit`; all four safety layers held |

The gate-5 and gate-6 blowouts are the small-sample concentration signature the gates were calibrated to catch; results on a 9.5h window have no meaningful inference power relative to the protocol. The capped replay confirms the envelope did not save anything — the policy lost money in the same hours it would have traded live.

**Decision:** no live canary. Halt before the holdout window means the pre-registered protocol cannot be honored against this run. Restart the data-collector for the formal ≥ 2026-06-02 holdout as originally specified in §13.9.

---

## 14. Status

```text
Last live session:   2026-05-15 → 2026-05-17    R1 + R2 + R3 + R4 + R5 + R6
                                                 n = 285 filled trades
                                                 cum PnL = −$32.99 (+ ~$11 manual sports bet)
                                                 Verdict: INCONCLUSIVE (regime hypothesis weak,
                                                          calibration falsified, edge tiny if real)

Live worker:         halted (no Kalshi orders permitted)
Shadow worker:       running (collects validator A/B + Layer 2 basis features)
BRTI A/B:            168 / 188 = 89.4% favoring BRTI (p = 1.27 × 10⁻³⁰)  → settled science
Layer 1 harness:     committed at 7fbcd73
Layer 2 logger:      committed at 71a6d62

Maker-replay harness (§13 — execution-side path, parallel to §4-6):
  Data collector:    stopped cleanly 2026-05-26T13:47Z after 30.79 h capture
                     (160 / 160 gzip files valid; integrity & adequacy PASS)
  Book reconstructor + queue model + adverse-selection scorer:  validated
                     (committed at adf86d6)
  Dumb BTC_TOUCH_DEPTH50 policy:  REJECTED on robustness grounds
  Refined BTC_YES_LATE_ASIA_v1:   PRE-REGISTERED + frozen; in-sample
                     exploratory recorded; awaiting holdout collection in
                     a calendar week ≥ 2026-06-02

  Non-holdout prerun shakeout (2026-05-27, §13.11):
    Prerun collector: halted 2026-05-27T09:34Z at 9 h 32 m (10/30 hour
                      buckets — NOT holdout-eligible; protocol violated
                      by early stop).
    Replays on the partial window (informational only):
      - Frozen v1:        −$4.26 PnL, 9 gate failures, gates 5 & 6 blown
                          out by single-market / single-2h-block dominance
      - $25 capped:       same −$4.26, max DD $12.64 (50.6% of bankroll)
      - Maker dry-run:    plumbing validated, 0 wire activity, 20
                          pending_confirm expired (ALLOW_ORDERS=0)
    Decision: NO live canary. Restart formal ≥ 2026-06-02 holdout.

Next decision point — signal path:    once shadow accumulates ≥80 settled markets
                     with non-null basis features, re-run brier_bakeoff.py.
                     If p_logistic_basis clears the three-criteria gate, R7
                     launches with hard-stop ≤ $8. If not → OFI top-5.

Next decision point — execution path:  collect a fresh 30 h-to-7 d holdout in
                     a calendar week distinct from 2026-05-25/26 → run the
                     unchanged BTC_YES_LATE_ASIA_v1 → binary 7-gate verdict.
                     If pass: discuss a tiny maker-only canary. If fail: v1
                     rejected; any v2 requires a fresh pre-registration on a
                     third sample.
```

The financial loss is paid forward as scientific evidence: a frozen labeled corpus, three validated infrastructure pieces (BRTI vs Binance settlement A/B; Layer 1/2 bakeoff system; maker-replay harness with per-quote PnL decomposition), and explicit gates on both research paths that prevent the next live exposure from happening on hope.
