# Adverse-selection scorer — BTC_TOUCH_DEPTH50 decomposition (2026-05-26)

- Module: `apps/data-collector/src/replay/adverseSelectionScorer.ts`
- Runner: `pnpm run score-adverse-selection`
- Input: 30h dataset, see [[kalshi-data-collector-30h-2026-05-26]]
- Policy under test: `BTC_TOUCH_DEPTH50` from [[kalshi-passive-policy-btc-touch-depth50-2026-05-26]]
- **Verdict: 2 of 4 pass criteria FAIL → STOP** before building the BTC maker replay

## What the scorer does

For each filled quote, decomposes the settlement PnL into:

```
settlement_PnL = spread_captured + adverse_selection_60s + residual_drift
```

where (in YES-bid units; NO-bid is mirrored):
- `spread_captured` = `(mid_at_fill − price)` — the realized fill-time edge vs current mid
- `adverse_selection_60s` = `(mid_at_fill+60s − mid_at_fill)` — the 60s post-fill drift
- `residual_drift` = `(settlement − mid_at_fill+60s)` — whatever's left until close

Identity verified: max |residual| = **1.42e-14¢** across 5,058 quotes. Decomposition math is exact.

The decomposition is then aggregated by **TTE × ToD × side × queue × fill latency × moneyness**.

> **Naming caveat:** "spread captured" here is `mid_at_fill − price`, not the theoretical half-spread at post time. For depth_50 / back-of-queue, by the time our queue position is reached, the mid has typically moved against us. A 5-term decomposition splitting `(M_post − P)` from `(M_fill − M_post)` would surface this more clearly; v1 matches the spec's 4-term form.

## Headline decomposition (depth_50, filled + settled)

| component | mean (¢/filled) |
|---|---:|
| spread captured | **−0.316** |
| adv selection @ 1s | −0.360 |
| adv selection @ 5s | −0.587 |
| adv selection @ 15s | −0.475 |
| adv selection @ 30s | −0.239 |
| adv selection @ 60s | **+0.474** |
| residual (60s → settlement) | **+0.497** |
| **settlement PnL** | **+0.655** |

### Reading the row
Filled quotes are filled at adverse prices (spread captured −0.32¢ = mid was already 0.3¢ below our quote price when our queue position was reached). Adv selection is U-shaped: most negative at 5-15s (mid keeps moving against us), then **mean-reverts** by 60s where adv selection is POSITIVE +0.47¢. Then drift to settlement adds another +0.50¢. Net: +0.65¢ per filled.

The shape **mean reversion > information** in the post-60s window is what makes the policy work at all on depth_50.

## Per-bucket decomposition

### B. TTE bucket — primary axis of concentration

| TTE bucket | n filled | spread | adv60 | residual | settlement (¢/filled) | settlement (¢/posted) |
|---|---:|---:|---:|---:|---:|---:|
| 0-3min | 227 | −0.850 | +0.954 | +1.023 | **+1.127** | +0.518 |
| 3-6min | 382 | −0.703 | −0.001 | −0.163 | −0.867 | −0.449 |
| **6-9min** | **376** | **−0.037** | **+1.129** | **+1.986** | **+3.077** | **+1.567** |
| 9-12min | 410 | −0.078 | +0.335 | −2.046 | −1.789 | −1.002 |
| 12-15min | 155 | +0.117 | −0.279 | +4.468 | **+4.306** | +2.628 |

**3 of 5 TTE buckets are positive per filled.** But two adjacent buckets (3-6min and 9-12min) are strongly negative — the pattern is non-monotonic and concentrated. **The 6-9min bucket alone contributes +0.391¢ to overall +0.344¢/posted EV; removing it drops total to −0.064¢/posted.**

### C. Side — primary axis of failure

| side | n filled | spread | adv60 | residual | settlement (¢/filled) | settlement (¢/posted) |
|---|---:|---:|---:|---:|---:|---:|
| **yes-bid** | 731 | +0.200 | +1.012 | +0.617 | **+1.830** | **+0.905** |
| **no-bid** | 819 | −0.776 | −0.007 | +0.389 | **−0.393** | **−0.218** |

**YES-bid alone has +0.905¢/posted; NO-bid is a net DRAG at −0.218¢/posted.** All components except residual flip sign between sides. NO-bid quotes:
- Pay more (negative spread captured: mid moved against us harder)
- Don't recover at 60s (adv60 near zero, not the +1¢ recovery YES-bid sees)
- Tiny residual

A natural explanation: KXBTC15M strikes are set near current BTC, and over the 30h sample BTC has a directional bias (or the order flow does — informed NO-sellers crossing to lift YES bids more aggressively than informed YES-sellers do on the NO side). Whatever the cause, **the policy works one-sided only.**

### D. Queue assumption

| queue | n filled | spread | adv60 | residual | settlement (¢/filled) | settlement (¢/posted) |
|---|---:|---:|---:|---:|---:|---:|
| front_of_queue | 2,563 | −0.193 | +0.137 | +0.663 | +0.607 | **+0.526** |
| depth_fraction_50% | 1,550 | −0.316 | +0.474 | +0.497 | +0.655 | +0.344 |
| back_of_queue | 945 | −0.473 | +0.811 | +1.904 | **+2.243** | **+0.717** |

**Back-of-queue per-posted EV is the highest** (+0.717¢) despite the lowest fill rate (~32%). Mechanism: back-of-queue fills happen after more pre-fill drift (more negative spread captured), but the cycle then mean-reverts further AND residual drift to settlement is much larger (+1.90¢ vs +0.50¢ for depth_50). This is the "patient maker" effect — wait longer, fill on extreme moves, capture mean reversion. Variance is high (this is a much-smaller-sample regime), Sharpe likely worse.

### E. Fill latency — strong non-monotonic effect

| latency | n filled | spread | adv60 | residual | settlement (¢/filled) |
|---|---:|---:|---:|---:|---:|
| <1s | 618 | −0.541 | +0.546 | +1.764 | **+1.770** |
| **1-5s** | 631 | −0.231 | +0.100 | **−1.265** | **−1.396** |
| **5-30s** | 227 | −0.342 | **−1.318** | +0.528 | **−1.132** |
| 30-300s | 62 | +0.790 | +5.987 | +5.050 | **+11.827** |
| 300s+ | 12 | +1.608 | +21.821 | +3.771 | **+27.200** |

**U-shaped EV by fill latency.** Quick fills (<1s) capture drift well. Medium fills (1-30s) are adversely selected and lose money. Slow fills (30s+) win big — when our quote is still alive 30s+ later, the market has likely walked toward us organically (uninformed drift fill).

This is the strongest microstructure insight from the decomposition: **the 1-30s fill window is the adverse-selection danger zone.** A refined policy should cancel quotes that haven't filled within ~1s, or hold them past 30s.

### F. Moneyness — directional markets win

| moneyness (|p − 0.5|) | n filled | spread | adv60 | residual | settlement (¢/filled) |
|---|---:|---:|---:|---:|---:|
| near_50 (<0.15) | 454 | +0.312 | −0.015 | −0.660 | −0.363 |
| lean (0.15-0.30) | 397 | +0.030 | +1.257 | +0.315 | **+1.602** |
| deep (≥0.30) | 699 | −0.920 | +0.347 | +1.352 | **+0.779** |

Near-50 markets (pure noise) LOSE. Directional markets (lean+deep) WIN. The residual drift component is much larger when the market has a clear direction to settle toward.

### G. Time-of-day — US hours hurt, Asia hours help

| UTC | n filled | spread | adv60 | residual | settlement (¢/filled) |
|---|---:|---:|---:|---:|---:|
| **00-04Z (Asia)** | 188 | −2.368 | +1.384 | +4.822 | **+3.838** |
| 04-08Z | 266 | +0.255 | +1.517 | +0.803 | +2.574 |
| 08-12Z | 387 | +0.254 | +0.873 | −1.803 | −0.676 |
| 12-16Z (US AM) | 264 | −0.723 | −0.483 | +0.831 | −0.376 |
| **16-20Z (US PM)** | 222 | −0.322 | −0.367 | −0.703 | **−1.392** |
| 20-24Z | 223 | +0.234 | −0.260 | +1.276 | +1.251 |

Asia hours and pre-NY-open dominate the edge. US trading hours show negative or near-zero EV per filled.

## Pass criteria — 2 of 4 FAIL

1. ✅ **TTE buckets with positive settlement EV: 3** — 0-3min (+0.518¢), 6-9min (+1.567¢), 12-15min (+2.628¢)
2. ❌ **Side EV/posted:** yes-bid **+0.905¢**, no-bid **−0.218¢**. *NO-bid is not positive.*
3. ✅ **Mean adv sel @ 60s: +0.474¢, mean residual: +0.497¢.** Adverse selection is bounded (within ±2¢ limit) AND positive net of recovery.
4. ❌ **Leave-best-bucket-out:** removing 6-9min TTE bucket drops EV/posted from **+0.344¢ to −0.064¢**. Edge depends on that single bucket.

**Verdict: STOP.** Per the agreed spec, edge vanishing after bucket decomposition means we do NOT proceed to build the BTC maker replay on this policy.

## What we learned (informs future work)

The decomposition has surfaced exactly *where the edge lives*:

1. **YES-bid only.** NO-bid is a structural drag (−0.22¢/posted) over this sample.
2. **6-9min TTE bucket carries the edge** (+1.57¢/posted; total without it is negative). The 12-15min bucket is even stronger per-filled (+4.31¢) but rarer (155 fills).
3. **Asia and early-Europe hours (00-08Z) are profitable; US hours are not.** The policy is essentially "BTC mean-reversion overnight, BTC trend during US hours."
4. **Fill-latency U-curve.** Cancel between 1-30s or hold past 30s — never linger in the adverse-selection middle.
5. **Avoid near-50 markets.** Directional markets are where the residual drift component pays off.
6. **Back-of-queue is the best per-posted EV** if you can tolerate the variance — patient quoting catches mean-reverting cycles.

These are conditional features that a *refined* policy could be built on. But the dumb blanket policy fails the robustness gates.

## What does NOT proceed

Per the agreed sequence and verdict:
- **Do NOT build the BTC maker replay on `BTC_TOUCH_DEPTH50`.** The edge is concentration-dependent and one-sided.
- **Do NOT relaunch the kalshi-worker.**
- **Do NOT reopen Layer-2 / Brier feature search.**

## Suggested next iteration (out of scope until operator decision)

The decomposition supports building a **late-life-weighted, one-sided, time-filtered BTC policy** of the form:

```
BTC_LATE_LIFE_YES_FILTERED:
  - YES-bid only at the best yes-bid
  - Active only in 6-15min TTE buckets
  - Active only in 00-12Z UTC
  - Cancel quotes still resting at 1-30s (skip adverse-selection zone)
  - depth_fraction_50% or back_of_queue queue assumption
  - Hold filled positions to settlement
```

Expected per-posted EV from cell-product extrapolation: roughly +1.5 to +3¢ per posted (vs the +0.34¢ of the blanket policy). Conditional on the structural features being stable — this is one 30h sample and conditional-policy EVs in microstructure are notoriously unstable across regimes.

But **this is a new policy that needs its own decomposition and validation cycle**, not just the existing pipeline rerun. Awaiting your decision on whether to invest in that.

## Statistical context

Settlement EV per posted on the primary policy = +0.344¢, n=2956. Per-quote PnL std ≈ 30¢. Standard error of mean ≈ 0.55¢. **t-stat ≈ 0.63, p ≈ 0.5** — the overall EV is consistent with zero on 30h. Bucket-level EVs are even noisier (e.g. 12-15min has only 155 filled quotes).

Statistical significance was never the bar at this stage; the goal was robustness via decomposition. The decomposition has correctly identified that the edge is not robust — concentrated on one side and one TTE bucket out of five.
