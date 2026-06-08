# v2-conditioned maker markout — KXBTC15M_PASSIVE_MAKER_v2 (2026-06-07)

- Scorer: `apps/data-collector/src/replay/v2Markout.ts`
- Fill source: `btcMakerV2.ts` via the opt-in `--dump-records` flag (additive instrumentation; no policy/settlement/gate change)
- Discovery proxy (NOT a gate): `autoresearch_layer2/markout.py`
- Input: 2026-06-04 → 2026-06-06, 00–08Z, BTC-only
- Policy under test: frozen v2 from [[kxbtc15m-v2-preregistration]] (back-of-queue, 75s TTL, cancel-on-widen/queue-deterioration, TTE 6–14min, moneyness `|touch−0.5| ∈ [0.15,0.40]` → touch ∈ [0.10,0.35] ∪ [0.60,0.90], yes-only)
- **Verdict: `INSUFFICIENT_DATA` — practical sample-size wall, NOT a GO. v2 frozen policy is not deployable.**

## Why this run exists

`btcMakerV2.ts` produces v2's exact filtered/TTL/cancel/back-of-queue fills and reports **settlement PnL**. The [[kalshi-adverse-selection-scorer-2026-05-26]] reports short-horizon **markout** but on *generic* both-side 60s-anchor quotes — not v2's fill set. Nobody had computed markout on the fills v2 would actually get. This run closes that gap, without reimplementing (and risking drift from) the prereg-locked policy: it consumes v2's `QuoteRecord` dump and marks each real fill forward against the same reconstructed book (`buildMarketIndex` + `midAtOrBefore`).

## The metric

v2 is yes-only — it posts a YES bid at touch, so on fill it is **long YES**:

```
markout(H) = (mid_yes(fillTs + H) − touchPrice) · 100      [cents/contract]
           = spread_captured + post-fill mid drift in the maker's favor
```

Positive = maker net ahead H seconds after fill. **Gross of fees** — the KXBTC15M v2 maker-fee assumption is 0.00 ([[kalshi-fee-assumption-kxbtc15m]]); mixing a settlement-fee haircut into a mark-to-mid number conflates two accounting objects. Fees belong in the settlement/capped replay gate, not here. This is a microstructure (adverse-selection persistence) gate, **not** a hold-to-settlement EV gate.

## Headline

194 posted · **29 fills** · spread captured at fill **+0.255¢**

| horizon | n | mean markout | 95% CI | mean adv-sel |
|---|---:|---:|:--|---:|
| 1s | 29 | −0.172¢ | [−0.811, +0.466] | −0.428¢ |
| 5s **(binding)** | 29 | −0.155¢ | [−0.928, +0.618] | −0.410¢ |
| 30s | 29 | −1.469¢ | [−3.715, +0.777] | −1.724¢ |
| 60s | 29 | +0.855¢ | [−2.609, +4.320] | +0.600¢ |

## The sign inversion (why the generic proxy is unsafe)

The discovery proxy (`markout.py`, every trade, optimistic always-filled-on-favorable-side) showed BTC markout **positive**: +0.14 → +0.49¢, ~12σ at n≈47k/2h. On v2's **back-of-queue** fills the point estimate goes **negative** at 1s/5s/30s.

Mechanism: a back-of-queue order only fills when its price level is **swept**, and sweeps are disproportionately **informed / toxic** flow. Conditioning on "v2 actually filled" therefore selects the toxic fills the optimistic proxy averaged away. The queue haircut did not merely shrink the edge — it **reversed its sign**. The +0.26¢ spread capture is more than eaten by −0.41¢ of 5s adverse selection.

**Caveat:** n = 29. The CIs are enormous and the markout is statistically indistinguishable from zero, from +0.3¢, and from −1¢. The defensible claim is *not* "the edge is negative" — it is "the optimistic proxy is unsafe and the honest test is unmet."

## The binding constraint is fill-rate, not edge size

v2 fills ~9.7×/day (29 in 3 days). The n ≥ 5,000 gate is **~515 days of 00–08Z collection** away. Even pooling *every byte* collected since 2026-05-25 (~11 eligible dates) yields only ~order-100 fills — still ~50× short. v2's frozen selectivity (00–08Z ∩ TTE 6–14min ∩ moneyness `|touch−0.5|∈[0.15,0.40]` ∩ back-of-queue ∩ per-market cap 1) makes its own markout gate unreachable on any realistic timeline. This is the same power problem as the directional Brier bakeoff (n≈118, gate min-detectable-effect ~8pp), re-emerging one level down: power is a property of how much the *policy* lets you observe, not of the market.

## Verdict rule (operator-set 2026-06-07, load-bearing)

Wired verbatim into `v2Markout.ts:GATE`. Like CLAUDE.md's σ-ceiling and `YES_MIN_EDGE`, these constants are policy, not tunables. GO **only if all** hold:

- series = `KXBTC15M`; queue = back-of-queue; gross of fees
- binding horizon **5s**: markout CI-low **≥ +0.10¢**
- rails: markout CI-low **> 0** at **1s, 30s, 60s**
- **n_fills ≥ 5,000**
- **≥ 3** distinct UTC dates
- no single market > **25%** of |markout PnL|
- no single 2h block > **40%** of |markout PnL|

Else `NO-GO` (data adequate, edge fails) or `INSUFFICIENT_DATA` (n / dates inadequate). This run: dates ✓, concentration ✓ (12.1% / 33.0%), but n=29 ≪ 5,000 → **`INSUFFICIENT_DATA`**.

## v3 scoping — filter sweep (2026-06-08, PRE-PREREG / NOT a gate)

`apps/data-collector/src/replay/v2FilterSweep.ts` re-encodes the v2 policy in parameterized form and sweeps candidate relaxations, reporting fills/collection-day, markout@5s, and settlement-EV/posted per cell. It is **equivalence-gated**: at v2's frozen params on the same window it must reproduce v2's exact 194/29 or it aborts (it MATCHED). Numbers are diagnostic only and shape a v3 prereg — they do not validate one.

| cell | posted | filled | fills/day | days→5k | markout@5s | EV/posted |
|---|---:|---:|---:|---:|---:|---:|
| v2_frozen (anchor) | 194 | 29 | 9.7 | 517 | −0.16¢ | −0.73¢ |
| moneyness band →0.10 | 211 | 30 | 10.0 | 500 | −0.03¢ | −1.61¢ |
| moneyness band →0.05 | 223 | 35 | 11.7 | 429 | −0.12¢ | −2.48¢ |
| TTE min 6→3 min | 227 | 35 | 11.7 | 429 | −0.01¢ | −0.92¢ |
| TTE [6,14]→[2,15] min | 232 | 37 | 12.3 | 405 | +0.12¢ | −0.75¢ |
| per-market cap 1→2 (net 2→4) | 333 | 41 | 13.7 | 366 | −0.31¢ | −0.83¢ |
| per-market cap 1→3 (net 2→6) | 370 | 44 | 14.7 | 341 | −0.19¢ | −0.94¢ |
| **STACKED safe** (mny0.10+TTE3+cap3/6) | 496 | 65 | 21.7 | **231** | +0.17¢ | −1.01¢ |
| spread-widen 1→2 / 1→3 tick | 194 | 29 | 9.7 | 517 | — | — |

Findings:
- **Spread-widen cancel is NOT the fill throttle.** Loosening it (1→2→3 ticks) recovers zero fills — the earlier `cancelReason` attribution (155/165 = spread_widen) was an artifact; those quotes weren't going to fill in 75s back-of-queue anyway. The real fill constraint is **back-of-queue depth × 75s TTL**. (Attribution ≠ causation; only the counterfactual revealed it.)
- **Per-market cap is the best safe lever:** ~2× fills (29→44), EV-neutral (−0.73→−0.94¢). TTE relaxation is similar (EV-neutral). These buy denominator without changing the regime's economics.
- **Moneyness widening craters settlement EV** (−0.73 → −2.48¢ at →0.05). Nearer-the-money YES bids are far more adversely/efficiently priced — do NOT widen moneyness toward 0.5 to chase n.
- **STACKED-safe halves days-to-5k (517→231)** without touching adverse-selection defenses; adding the untested hours lever (00–08Z→24h, ~3×) → ~75 days. But **every cell's settlement EV is negative** (−0.7 to −2.5¢/posted): a v3 that is merely "v2 with looser filters" reaches a *powered −EV in ~2–3 months* — faster, not better.
- markout@5s and settlement-EV **disagree in sign** in the stacked cell (+0.17¢ vs −1.01¢): markout stays a microstructure filter, settlement EV the real gate.

The true fill-*rate* levers (longer TTL, less-conservative queue) are untested and are the adverse-selection-importing ones; the clean path is denominator-only.

## Decision

**v2 frozen policy: not deployable.** Reason: under actual v2 queue/cancel/filter conditioning, fill count is far below the prereg sample gate and markout no longer supports the generic-fill optimism.

**No broadening inside the current prereg.** [[kxbtc15m-v2-preregistration]] freezes every parameter, threshold, gate, data window, queue assumption, and fee assumption before holdout scoring, and hard-prohibits post-hoc gate relaxation and short-window / same-week validation (cf. the VOID record [[kxbtc15m-v2-VOID-holdout-run-on-designcorpus-2026-05-30]]).

**Next path is a v3 prereg, not a v2 amendment.** Per the sweep, a data-efficient v3 raises fills via the EV-neutral denominator levers (**per-market cap + TTE + hours**, ~75 days to n=5,000) and **avoids moneyness widening** (it craters settlement EV). Reuse `v2Markout.ts` + `v2FilterSweep.ts` as the harness, **only after** writing a new preregistration — and only if motivated by a genuine new edge hypothesis, since every swept cell is settlement-EV-negative (looser filters alone just reach a powered −EV faster). The settlement-EV holdout gate remains a separate, distinct layer.
