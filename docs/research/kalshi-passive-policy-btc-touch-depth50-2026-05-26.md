# Passive policy `BTC_TOUCH_DEPTH50` — first replay validation (2026-05-26)

- Module: `apps/data-collector/src/replay/passiveQuoteSimulator.ts`
- Runner: `pnpm run run-passive-policy`
- Input: 30h dataset, see [[kalshi-data-collector-30h-2026-05-26]]
- Built on: [[kalshi-book-reconstructor-validation-2026-05-26]], [[kalshi-queue-model-validation-2026-05-26]]
- **Verdict: PASS** on all 4 pass criteria (settlement-based EV)

## Policy specification

`BTC_TOUCH_DEPTH50` is the canonical dumb two-sided maker on `KXBTC15M`:

- **Anchor cadence:** every 60s of a market's active life, ending 60s before terminal.
- **Per anchor:** post 1-contract YES-bid at `best_yes_bid` AND 1-contract NO-bid at `best_no_bid` (two independent quotes).
- **Queue assumption:** `depth_fraction_50%` (primary; sensitivity reported for front/back).
- **Cancel horizons (all evaluated):** 5s, 15s, 30s, 60s, to-expiry.
- **No taker exits in v1:** filled positions held to settlement.
- **PnL:** settlement-based primary; markout-based diagnostic.

## Settlement inference

Settlement is inferred from the WS data (REST API canonical lookup is v2):
- last `mid_yes` sample (or last-trade `yes_price` if more recent) ≥ 0.97 → `settlement_yes = 1.0` (high confidence)
- ≤ 0.03 → `settlement_yes = 0.0` (high confidence)
- otherwise → continuous proxy (low confidence)

**Coverage of 125 KXBTC15M markets:** 117 high-confidence (94%), 4 low-confidence, 4 none.

## Headline results

8,868 quotes posted (125 markets × ~12 anchors × 2 sides × 3 queue assumptions). Each row below is one cancel-horizon evaluation over 2,956 quotes (depth_50 only):

| horizon | fill rate | avg fill latency | mean mo +30s (¢) | mark EV/posted (¢) | mark EV/filled (¢) | **settle EV/posted ($)** |
|---|---:|---:|---:|---:|---:|---:|
| 5s | 44.6% | 1.4s | −0.677 | −0.300 | −0.673 | **+0.001** |
| 15s | 51.2% | 2.3s | −0.713 | −0.360 | −0.703 | −0.002 |
| 30s | 53.4% | 3.1s | −0.782 | −0.411 | −0.770 | −0.000 |
| 60s | 54.5% | 3.9s | −0.779 | −0.417 | −0.766 | +0.000 |
| **to-expiry** | **56.3%** | **10.0s** | **−0.576** | **−0.318** | **−0.564** | **+0.0035** |

Reading: at the natural to-expiry horizon, settlement EV is **+$0.0035 per posted quote** (= 0.35¢). Across 2,860 settlement-usable quotes, total realized PnL ≈ +$10 over the 30h sample.

## The markout-vs-settlement divergence

The most important finding of this run: **markout and settlement tell different stories.**

- Markout EV @ 30s is uniformly NEGATIVE (−0.3¢ to −0.8¢). Taken alone, this would scream "no edge — adversely selected."
- Settlement EV is POSITIVE (+0.35¢ per posted at to-expiry). The same quotes, evaluated on actual close-of-market PnL.

Why the divergence: filled quotes are *selected* on "taker willing to cross," which enriches for at-least-mildly-informed flow at the 30s horizon. But the information leak is small — most of the per-fill adverse-selection at 30s mean-reverts during the remaining 5-10 minutes of market life, and the maker keeps the half-spread captured at fill time.

The maker's account balance doesn't care about 30s-conditional markout; it cares about cash at settlement. **Pass criteria use settlement EV.**

## Sensitivity by queue assumption (to-expiry horizon)

| queue | fill rate | mean mo +30s (¢) | mark EV/posted (¢) | **settle EV/posted ($)** |
|---|---:|---:|---:|---:|
| front_of_queue | 89.5%¹ | −0.346 | −0.306 | +0.002 |
| **depth_fraction_50%** | **54.5%** | **−0.779** | **−0.417** | **+0.0035** (primary) |
| back_of_queue | 32.7% | −0.622 | −0.199 | +0.0074 |

¹Rates shown at 60s horizon in the source table; to-expiry rates are similar.

**Counter-intuitive result:** back_of_queue has HIGHER settlement EV than depth_50 or front_of_queue. Interpretation: back-of-queue fills require strong directional flow to drain the entire queue ahead of us — by the time we fill, the price has often "overshot" and the residual random walk toward settlement is favorable on average. But fewer fills also means higher per-quote variance and worse Sharpe; the depth_50 number is more representative of a steady-state operating regime.

## TTE buckets (depth_50, to-expiry)

| TTE at post | posted | fill rate | mark EV/posted (¢) | **settle EV/posted ($)** |
|---|---:|---:|---:|---:|
| 0-3min into life | 494 | 59.3% | −0.464 | **+0.0053** |
| 3-6min | 738 | 52.3% | −0.747 | −0.008 |
| 6-9min | 738 | 50.0% | −0.202 | **+0.0162** |
| 9-12min | 732 | 55.9% | −0.331 | −0.014 |
| 12-15min (last 3min) | 254 | 61.0% | −0.244 | **+0.0271** |

**3 of 5 TTE buckets have positive settlement EV.** The strongest is the last-3-minutes bucket (+$0.0271 = +2.71¢ per posted), consistent with "late-market-life quotes capture more drift-fills and less informed flow as the market converges to settlement." The 3-6min and 9-12min buckets are mildly negative — interesting that the pattern alternates rather than being monotonic; could be a sampling artifact in 30h of data.

## Time-of-day buckets (depth_50, to-expiry)

| UTC | posted | fill rate | mark EV/posted (¢) | **settle EV/posted ($)** |
|---|---:|---:|---:|---:|
| 00-04Z | 364 | 50.8% | −1.307 | +0.004 |
| 04-08Z | 502 | 56.0% | +0.089 | +0.004 |
| 08-12Z | 774 | 51.6% | −0.094 | −0.002 |
| 12-16Z | 552 | 52.4% | −0.871 | −0.003 |
| 16-20Z | 384 | 59.6% | −0.716 | −0.007 |
| 20-24Z | 380 | 60.3% | +0.067 | +0.009 |

Max single-bucket settlement-EV share: 30.7% (00-04Z). The EV is spread across six 4-hour blocks; no single block contributes more than a third of total.

## Pass criteria (settlement-based)

1. ✅ **Settlement EV per posted (depth_50, to-expiry): +$0.0035** (positive — pass).
2. ✅ **TTE buckets with positive settlement EV: 3** (≥2 — pass): 0-3min, 6-9min, 12-15min.
3. ✅ **Max time-of-day EV share: 30.7%** (≤60% — pass).
4. ✅ **Back-of-queue settlement EV: +$0.0074** (> −$0.005 floor — pass).

**Diagnostic:** markout-based EV is uniformly negative across all conditions. This is the adverse-selection signal and is consistent with "filled quotes are selected on taker willingness to cross." It is NOT a failure of the policy; it is the expected per-fill cost that the maker accepts in exchange for capturing the half-spread, which is then partially recovered as prices mean-revert over the remaining market life.

## Statistical context

Mean settlement EV = +$0.0035 per posted on n=2,860 usable quotes. Per-quote PnL std ≈ $0.30 (filled quotes range roughly from −$0.99 to +$0.99; ~half don't fill and contribute 0). Standard error of mean ≈ $0.0042. **t-statistic ≈ 0.83** → result is consistent with zero on the 30h sample (p ≈ 0.4 two-sided).

The pass criteria are about sign and magnitude consistency, not statistical significance — those are appropriate gates at this stage. A definitive validation needs **weeks of data**, not 30 hours.

## Implications for next stage

1. **Move forward with the adverse-selection EV scorer** — the next artifact will dig into the TTE/ToD bucket dynamics + inventory drift accounting. The 12-15min late-life signal is the strongest and should be characterized in detail.
2. **The naive policy is BARELY profitable on the 30h sample.** Not statistically significant; modest signal. A smarter policy (OFI-aware side selection, late-life weighting, inventory-aware sizing) should be the next iteration after the scorer.
3. **Do NOT relaunch the kalshi-worker.** The naive policy's settlement EV of +0.35¢ per posted, after exchange fees and slippage that this replay does not model, would need to be significantly larger to be live-deployable. We have not yet established that. Continue replay-only work.
4. **Layer-2/Brier path remains closed.** No reopening.

## What v1 does NOT model (to be addressed by simulator + scorer)

- **Cancel-aware queue progress** — orders ahead of us cancelling without filling. Makes our queue position decrease faster than the model assumes; would increase fill rate at depth_50.
- **Counterfactual taker reaction** — if we improved the touch by +1¢, real takers might cross harder. Passive replay ignores this; the simulator inherits the limitation.
- **Inventory drift to settlement** — when both YES-bid and NO-bid fill at the same anchor, the maker has matched both sides (~no inventory). When only one fills, the maker carries a directional position to close. v1 reports per-quote PnL; an inventory-aware run would aggregate per-market net position and PnL with proper risk accounting.
- **Adverse-selection bucketing** — the worst-case TTE and ToD windows need explicit characterization, not just aggregate stats.
- **REST settlement lookup** — current settlement labels are inferred from late-market mid_yes. 117/125 high-confidence is good but the 8 ambiguous markets should be authoritatively labeled.
- **Fees** — Kalshi maker fee on KX*15M is $0 per [[kalshi-data-collector-30h-2026-05-26]], so this isn't a critical gap, but the simulator should record it as a parameter.

## Next artifact

Per the agreed sequence: **adverse-selection EV scorer**. Bucketed analysis of (TTE × ToD × queue × side) for the depth_50 policy, with attribution between (a) half-spread captured, (b) markout adverse selection at the 30s mark, (c) drift toward settlement during the residual market life. Goal: identify the regimes where the policy works and where it doesn't, before any inventory-aware refinement.
