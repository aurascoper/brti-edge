# Queue-position model — validation (2026-05-26)

- Module: `apps/data-collector/src/replay/queueModel.ts`
- Validator: `apps/data-collector/src/replay/validateQueueModel.ts` (`pnpm run validate-queue-model`)
- Input: 30h dataset from [[kalshi-data-collector-30h-2026-05-26]]; book reconstruction primitive from [[kalshi-book-reconstructor-validation-2026-05-26]]
- Status: **all four sanity checks PASS**

## What the queue model does

Given a hypothetical resting maker order `(market_ticker, side, price, size, posted_at)` and a queue-position assumption, simulate forward through the historical trade tape and report:
- Initial book state (best bid/ask, mid, depth at our level)
- Distance from best on our side (in cents; positive = improving)
- Queue ahead at post time
- Cumulative trade volume through our level
- Fill outcome (filled/not, fill timestamp, fill fraction)
- Maker-perspective markout at +1s/+5s/+15s/+30s/+60s
- Settlement (reserved; null in v1)
- Diagnostic flags (market terminated, level depleted)

## Fill semantics (Kalshi-specific)

Resting maker quote = a BID on one of the two books:
- **YES-bid at price P_y** → filled by NO takers (`taker_outcome_side="no"`) at `trade.yes_price_dollars == P_y`
- **NO-bid at price P_n** → filled by YES takers (`taker_outcome_side="yes"`) at `trade.no_price_dollars == P_n`

Each trade event is a single matched fill at one price level. A taker sweeping multiple levels generates multiple trade events.

## Queue assumptions

| assumption | queue_ahead at post |
|---|---|
| `front_of_queue` | 0 |
| `depth_fraction_X%` | floor(X% × depth_at_level_at_post) |
| `back_of_queue` | full depth_at_level_at_post |

FIFO consumption: each matching trade reduces `queue_ahead` by `min(trade.count, queue_ahead)`. Any residual eats our remaining size.

## What v1 deliberately does NOT model

1. **Cancel-aware queue progress.** Orders ahead of us cancelling (without filling) shrink the queue in reality; v1 doesn't model this, making the model *conservative* (over-estimates queue obstruction).
2. **Counterfactual taker reaction.** In a passive replay, the historical tape proceeds as it actually did regardless of our hypothetical quote. Posting above the historical best places us alone at a new level, fillable only via organic market drift. A live counterfactual simulator would model taker reaction to our improvement; v1 does not.
3. **Our own cancel logic.** Quote is treated as GTC until market terminates or we fill.
4. **Settlement (BRTI fix lookup).** Reserved for external lookup; v1 leaves null.
5. **Pro-rata fills.** Kalshi is FIFO; `depth_fraction` is a middle-ground initial queue position, not a pro-rata fill rule.

## Validation grid

- 250 markets (125 KXBTC15M + 125 KXETH15M)
- 3 anchor times per market (at +3min, +6min, +9min from market open)
- 5 price offsets relative to anchor-time best yes-bid: `+1, 0, -1, -3, -5` cents
- 3 queue assumptions: `front_of_queue`, `depth_fraction_50%`, `back_of_queue`
- 10,806 simulations total; 55s wall-clock after a 64s index-build

## Results

### KXBTC15M — fill rate by queue assumption

| offset (¢) | front | depth_50 | back |
|---:|---:|---:|---:|
| +1 (improving) | 78.8% | 78.8% | 78.8% |
| 0 (at best) | **91.1%** | 55.3% | 32.8% |
| -1 | 79.0% | 36.3% | 25.4% |
| -3 | 69.7% | 24.6% | 15.1% |
| -5 | 65.5% | 29.3% | 19.9% |

(Improving fill rates are identical across queue assumptions because depth at the new level is 0 — all assumptions collapse to queue_ahead=0.)

### KXBTC15M — front-of-queue conditional markout (cents, maker perspective)

| offset (¢) | +1s | +5s | +15s | +30s | +60s |
|---:|---:|---:|---:|---:|---:|
| +1 | +0.00 | +0.53 | +1.43 | **+1.58** | +1.13 |
| 0 | +0.07 | +0.13 | +0.64 | **+1.21** | +1.03 |
| -1 | -0.54 | -0.92 | -0.19 | -0.12 | -0.82 |
| -3 | -1.05 | -1.22 | -0.91 | -0.62 | -0.47 |
| -5 | -0.89 | -1.23 | -0.51 | +0.22 | +0.45 |

### KXETH15M — fill rate by queue assumption

| offset (¢) | front | depth_50 | back |
|---:|---:|---:|---:|
| +1 (improving) | 55.6% | 55.6% | 55.6% |
| 0 (at best) | **73.1%** | 28.3% | 12.2% |
| -1 | 65.7% | 24.5% | 17.3% |
| -3 | 56.8% | 15.1% | 11.9% |
| -5 | 52.6% | 11.7% | 7.0% |

### KXETH15M — front-of-queue conditional markout (cents, maker perspective)

| offset (¢) | +1s | +5s | +15s | +30s | +60s |
|---:|---:|---:|---:|---:|---:|
| +1 | -0.13 | -0.08 | -0.32 | -0.55 | +1.17 |
| 0 | -0.04 | +0.11 | +0.08 | +0.15 | +0.33 |
| -1 | +0.25 | -0.31 | +0.04 | +0.50 | +1.90 |
| -3 | +0.40 | +0.13 | -0.31 | -0.47 | +0.98 |
| -5 | +0.14 | +0.58 | +0.12 | -0.46 | -1.41 |

## Sanity checks (all pass)

1. **Fill rate monotonically decreases as offset moves behind best** (front-of-queue, BTC + ETH).
   - BTC: 0¢ 91.1% → -1¢ 79.0% → -3¢ 69.7% → -5¢ 65.5% ✓
   - ETH: 0¢ 73.1% → -1¢ 65.7% → -3¢ 56.8% → -5¢ 52.6% ✓
2. **Tighter queue assumption => lower fill rate at every offset.**
   - BTC offset=0: front 91.1% > depth_50 55.3% > back 32.8% ✓ (and similar at every offset for both series)
3. **Maker captures positive markout at the touch** (offset=0, front-of-queue, 30s).
   - BTC: +1.21¢ ✓
   - ETH: +0.15¢ ✓
4. **Conditional markout degrades as quote moves behind best** (offset=0 vs offset=-5, front-of-queue, 30s).
   - BTC: 0¢ +1.21¢ → -5¢ +0.22¢ (drop 0.99¢) ✓
   - ETH: 0¢ +0.15¢ → -5¢ -0.46¢ (drop 0.61¢) ✓

## Diagnostic — passive-replay structural effect (not a failure)

Posting at +1¢ above the historical best gives **LOWER** fill rate than at the touch:
- BTC: +1¢ 78.8% < 0¢ 91.1%
- ETH: +1¢ 55.6% < 0¢ 73.1%

This is expected. Our +1¢ quote sits alone at a new level; real takers do not react to our improvement in a passive replay; the historical tape proceeds unchanged. The +1¢ quote fills only via organic upward drift. The conditional markout for those fills is also positive (selection bias on favorable drift). Both signals would invert in a counterfactual / live simulator that models taker reactivity — out of scope for v1.

## Implications for the maker simulator

1. **Realistic operating regime is `depth_fraction_50%` at offset 0.** Real makers won't be at the front of every queue, and won't be at the back either. Mid-queue is the honest default for live posting. BTC: 55.3% fill rate, +1.07¢ 30s markout. ETH: 28.3%, -0.25¢. **BTC looks viable on these numbers; ETH is marginal.**
2. **Front-of-queue is a theoretical upper bound.** Achieving it requires posting first when the level opens (post-immediately-after-snapshot strategies). Possible but rare on liquid BTC books.
3. **Back-of-queue is a conservative lower bound.** Posting into a deep existing queue rarely fills before market terminates. The 32.8% BTC fill rate at offset=0 back-of-queue means about 2/3 of such quotes don't fill within their 15-min market window.
4. **Improving (+1¢) is not "free EV"** in a replay. The structural penalty applies in any historical analysis. Production would need a counterfactual model (e.g. taker-elasticity) to estimate true expected gain from improving.

## What's next

Per the agreed sequence, the next artifact is the **passive quote simulator** — a higher-level shell around `simulateQuote()` that:
- Tracks inventory and cash across many quotes over a market's life
- Models cancel-and-repost logic (re-quoting strategy)
- Handles partial fills feeding back into next-quote decisions
- Computes per-market and aggregate EV including inventory drift to settlement

After that: adverse-selection EV scorer (bucketed by TTE / time-of-day), then BTC-only end-to-end maker replay.

Do not relaunch the kalshi-worker. Do not restart collection. Do not reopen Layer-2/Brier feature search.
