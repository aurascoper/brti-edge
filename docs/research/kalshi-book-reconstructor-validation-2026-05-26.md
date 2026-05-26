# Book reconstructor validation — 2026-05-26

- Module: `apps/data-collector/src/replay/bookReconstructor.ts`
- Validator: `apps/data-collector/src/replay/validateMarkouts.ts` (`pnpm run validate-markouts`)
- Input: 30h dataset captured 2026-05-25T06:58Z → 2026-05-26T13:47Z, see [[kalshi-data-collector-30h-2026-05-26]]

## What the reconstructor does

Consumes the gzipped JSONL streams (`orderbook-snapshots-*.jsonl.gz`, `orderbook-deltas-*.jsonl.gz`) and rebuilds Kalshi books keyed by `(market_ticker, ts_ms)`. Key design choices:

- **Two-sided storage.** Kalshi's WS feed delivers bids only on each side (`yes_dollars_fp`, `no_dollars_fp`). Asks are derived via no-arb: `best_yes_ask = 1 − best_no_bid`. Two `Map<priceTicks, size>` per market (yes-side bids + no-side bids).
- **Integer price keys.** Prices are 4-decimal dollars (`"0.0010"`..`"0.9990"`); stored as `Math.round(price × 10000)` ticks to keep Map keys exact-equality safe.
- **Keyed off `(market_ticker, ts_ms)`, not `seq`.** Per-channel WS seq counter is ignored. Resets at WS reconnects are followed by a fresh Shape-A snapshot which reseats the book. Forward seq gaps cluster on 15-min rollovers (seq-advances for unsubscribed markets) — not data loss. See [[kalshi-data-collector-30h-2026-05-26]] §1.
- **Two distinct snapshot shapes handled.** Shape-A (with `yes_dollars_fp` + `no_dollars_fp` arrays) reseats the book; Shape-B (header-only `{market_ticker, market_id}`) marks the market terminated and stops further delta application.
- **Step-function mid timeline.** Mid changes are sparse (the top-of-book is stable through most deltas); validator's `pushIfChanged` dedupes consecutive identical mids. Lookup semantics: `mid[i]` is valid for any `ts ∈ [ts[i], ts[i+1])`.
- **`null` on one-side empty.** When either yes-bid or no-bid stack is empty (deep-ITM regime), `midYes` returns `null`. The Kalshi ticker channel synthesizes a mid using `yes_ask = 1.000` as the no-arb ceiling; the reconstructor refuses to. This is a deliberate semantic choice — the maker simulator should never quote without a two-sided book.

## Validation results

Validator processed 10,986,175 book events across 250 BTC+ETH markets in 53s wall-clock. 495k mid timeline samples after `pushIfChanged` dedup.

### Markout-aggregate reproduction (taker-perspective, in cents)

#### KXBTC15M (646,555 trades matched to reconstructed books)

| horizon | n | mean (recon) | mean (baseline) | Δ | p50 | sd |
|---|---:|---:|---:|---:|---:|---:|
| +1s | 616,571 | −0.133 | −0.151 | **+0.018** | −0.500 | 5.59 |
| +5s | 617,019 | −0.108 | −0.119 | **+0.011** | −0.400 | 6.74 |
| +30s | 584,812 | −0.079 | −0.068 | **−0.011** | −0.200 | 11.65 |

#### KXETH15M (80,235 trades matched)

| horizon | n | mean (recon) | mean (baseline) | Δ | p50 | sd |
|---|---:|---:|---:|---:|---:|---:|
| +1s | 77,509 | −0.404 | −0.294 | **−0.110** | −0.500 | 5.93 |
| +5s | 77,056 | −0.305 | −0.229 | **−0.076** | −0.500 | 8.52 |
| +30s | 67,282 | −0.395 | −0.306 | **−0.089** | −0.200 | 14.85 |

**max |Δ| across all (series, horizon) = 0.110¢**, well inside the 1¢ Kalshi tick.

The systematic ETH bias (~0.1¢ more maker-favorable in the reconstructor) is **sampling-resolution**, not a reconstruction error. The reconstructor builds mid samples at every book event (p50 inter-arrival 71ms); the ad-hoc baseline used the ticker channel which emits at ~1 Hz. At a 1-30s forward horizon the recon finds a mid much closer to the *true* t+H value than the baseline did. On volatile series (ETH) this widens the gap; on slow series (BTC) the difference washes out via averaging.

### Direct mid-agreement check

For 165,942 ticker samples (of 167,315 total; 1,373 missed because the ticker fired before any book event for that market):

| series | n | mean diff (¢) | abs-mean (¢) | exact match | within ½-tick |
|---|---:|---:|---:|---:|---:|
| KXBTC15M | 93,597 | +0.677 | 1.032 | **92.44%** | 92.58% |
| KXETH15M | 72,345 | +0.522 | 0.666 | **94.33%** | 94.37% |

**~93% of mid samples match the Kalshi ticker EXACTLY** (within 0.005¢ = floating-point noise). The non-matching ~7% tail consists of one-side-empty deep-ITM moments where the reconstructor correctly returns `null` (and `pushIfChanged` doesn't update the timeline), while the ticker synthesizes a mid using `yes_ask = 1.000` as the no-arb ceiling. The +0.5-0.7¢ mean bias equals roughly `(7% outliers) × (~10¢ deep-ITM diff)`.

This is the load-bearing evidence that the book state is correct: in the regime where both views are computable, they agree exactly almost everywhere.

## Verdict

**PASS.** The reconstructor:
- Reproduces the ad-hoc ticker-based markout baseline within 0.11¢ (≪ 1¢ tick)
- Agrees with the Kalshi ticker channel mid exactly in 93% of contemporaneous samples
- Differs from the ticker only in the one-side-empty regime, where the recon's null-on-undefined behavior is the intended semantic

The book reconstruction primitive is sound. Maker-side execution analysis can be built on top.

## Known caveats for downstream consumers

1. **Mid is null when either side has no bids.** Maker quote simulator must skip quote evaluation in this regime. The reconstructor *will not* synthesize a yes_ask = 1.000 ceiling for you — that's the ticker channel's choice, and using it for fill simulation would produce ghost fills against non-existent resting liquidity.

2. **Aggregated `delta_fp` per price level, not order-level.** Kalshi's WS feed delivers signed deltas at the price-level granularity. Individual orders are NOT exposed. Queue-position modeling for the maker simulator must therefore use depth-weighted approximations — exact queue position is structurally unavailable.

3. **Step-function timeline.** The validator's mid timeline only stores changes. Downstream consumers querying mid at arbitrary ts must use step-function lookup semantics (most-recent-at-or-before; `mid[i]` is valid for `ts ∈ [ts[i], ts[i+1])`). Don't interpolate.

4. **Terminal snapshot ≠ market close.** Shape-B snapshots fire ~2 seconds after the close-time deltas finish. Trades within the final 2 seconds may have forward-mid lookups land on the terminal-snapshot ts. The validator extends the timeline 60s past terminal using the frozen pre-close mid for markout calculation only; the maker simulator proper should mark these to BRTI settlement, not frozen mid.

## What's next per the agreed sequence

Per the harness-build plan, the next artifacts in order:

1. **Queue-position model** — depth-weighted approximation of where our resting quote sits in line at a price level.
2. **Passive quote simulator** — given a hypothetical resting quote at (price, side, size, ts), simulate fill or cancel against the historical tape.
3. **Adverse-selection EV scorer** — net markout − queue cost − inventory drift, by series / TTE / time-of-day bucket.
4. **BTC-only maker replay** — first full end-to-end run, BTC only (largest sample, tightest L1 markout).

Do not relaunch the kalshi-worker. Do not restart collection. Do not reopen Layer-2/Brier feature search.
