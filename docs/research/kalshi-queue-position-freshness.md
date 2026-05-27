# Kalshi `queue_position_fp` freshness — methodology + measurement record

**Status:** methodology archived; **empirical measurement pending**
**Created:** 2026-05-27
**Verifies (partially):** §10 of `kxbtc15m-v2-preregistration.md`
**Required for:** preregistration **lock** (methodology must exist) + live **canary** (measurement must exist)

This document exists in two phases:
1. **Phase 1 (now):** methodology + the *known unknowns* about Kalshi queue-position freshness. This is the lock prerequisite.
2. **Phase 2 (before any canary):** filled-in empirical numbers from a shadow-mode measurement campaign. This is the canary prerequisite per v2 preregistration §15.

No live orders are placed for this measurement. Phase 2 uses Kalshi's existing shadow infrastructure — the data collector + a single dummy resting order placed and immediately cancelled (or, if available, a Kalshi sandbox account) — to bound the freshness without exposure.

---

## 1. Why this matters

Kalshi exposes queue position via:

```
GET /portfolio/orders/{order_id}/queue_position  →  { queue_position_fp: <int> }
```

The endpoint documentation (verified 2026-05-27 at https://docs.kalshi.com/api-reference/orders/get-order-queue-position) defines `queue_position_fp` as *"the number of preceding shares before the order in the queue"* under price-time priority. The docs **do not specify**:

- update frequency (how often the field is recomputed server-side)
- propagation latency (how long after a trade or cancel the field reflects the new state)
- subscription / streaming mechanism (the endpoint is REST-only as documented)
- staleness guarantees under load
- consistency model relative to the public WebSocket trade stream

These gaps are **operationally load-bearing for v2**. If the strategy makes a cancel decision based on `queue_position_fp = 3` but the actual queue has already moved to position 1 (or to filled), the cancel either races a fill (worst case: missed-queue-slot regret) or cancels an in-the-money queue slot (worst case: pays opportunity cost of the captured ½-spread).

For maker profitability at a $5 exposure cap and ~1¢ captured-half-spread budget, stale queue reads of more than a few seconds can flip the sign of the EV calculation.

## 2. What "fresh enough" means for v2

v2's quote duration is `<fill in preregistration §7.4>` seconds. Within that duration, the strategy may issue at most one cancel decision per quote. For the cancel decision to be reliable, the `queue_position_fp` read must satisfy:

```text
freshness_budget_seconds = quote_duration_seconds × 0.10
                         (≤ 10% of the quote's intended lifetime)
```

If freshness > budget, the cancel decision is being made on stale state and v2 cannot honor its cancellation-aware accounting (§7.4 of the preregistration).

For a 75-second quote duration (placeholder estimate; locked in preregistration), freshness budget ≈ 7.5s.

## 3. Measurement methodology (Phase 2 — pending)

### 3.1 Setup

1. **Shadow Kalshi account** with a working API key (`KALSHI_API_KEY_ID` + RSA private key per the worker's existing `loadEnvFromLiveTrading()` path) and a non-zero (but small, e.g. $5–$10) deposit so order placement is permitted.
2. **One deep-OTM passive limit order** placed at a price far from touch (e.g., YES bid at $0.05 on a market where touch is $0.45). The order should:
   - be at a price level where market activity is rare (so the queue actually has length and isn't churning constantly)
   - be sized at 1 contract (minimum exposure)
   - have a long TTL on Kalshi side (or be re-placed manually)
3. **No expectation of fill.** The deep-OTM placement is specifically chosen to maximize the probability that the order rests untouched for the entire measurement window. The exposure is `1 × $0.05 = $0.05` — small enough to discard if accidentally filled.
4. **Cancel immediately if any fill is observed.**

### 3.2 Data collection

Run two parallel measurements:

**(A) Endpoint latency** — how long does the GET request take?

```text
for i in 1..N (N >= 1000):
    t0 = now_monotonic()
    response = GET /portfolio/orders/{our_order_id}/queue_position
    t1 = now_monotonic()
    record (t1 - t0)
```

Report:
- p50, p90, p99 latency
- error rate (timeouts, 5xx)
- rate-limit headers if present

**(B) Field staleness** — how long after a queue change does `queue_position_fp` update?

This requires correlating two streams:
- WebSocket trades on the same price level (`taker_book_side = "bid"` for our YES-bid case at our price)
- Polled `queue_position_fp` reads at ~1Hz

For each WS trade that should have advanced our queue by `count_fp`:

```text
t_trade        = ws.received_at
qpos_before    = last polled qpos before t_trade
qpos_after     = first polled qpos after t_trade where qpos changed
staleness_obs  = first_polled_at_time(qpos changed) - t_trade
```

Report:
- distribution of `staleness_obs` (p50, p90, p99)
- fraction of trades for which qpos updated within the freshness budget (§2)
- fraction of trades for which qpos *never* updated within a 60s observation window after the trade (silent-stale rate)

### 3.3 Sample size

At least **N=1000** endpoint reads for latency, and at least **N=200** observed queue-advancing trades for staleness. If 200 trades cannot be observed in 24h of measurement, the deep-OTM choice was too deep — re-run at a price level with more activity.

### 3.4 Pass criteria for canary go-ahead

```text
endpoint p99 latency       < 1.0 s
staleness p90              < 5 s
staleness p99              < freshness_budget_seconds  (≤ 10% of quote duration)
silent-stale rate          < 0.5% of advancing trades
```

If any criterion fails, the canary is blocked. v2's cancellation-aware semantics cannot be honored on stale state, and the holdout score becomes unreliable as a predictor of live behavior.

## 4. Measurement record (Phase 2 — to be filled)

```text
measurement_date       = <fill>
measurement_duration_h = <fill>
shadow_account_id      = <fill>
test_order_id          = <fill>
test_order_market      = <fill>
test_order_price       = <fill>
test_order_size        = 1
exposure_usd           = <fill, ≤ 0.05>

endpoint_latency_p50_ms = <fill>
endpoint_latency_p90_ms = <fill>
endpoint_latency_p99_ms = <fill>
endpoint_error_rate     = <fill>
rate_limit_headers      = <fill, observed values>

staleness_observations  = <fill, count>
staleness_p50_s         = <fill>
staleness_p90_s         = <fill>
staleness_p99_s         = <fill>
silent_stale_rate_pct   = <fill>

canary_pass_criteria_met = <true | false>
notes                    = <fill>
```

Once filled, the v2 preregistration `<fill>` for `queue_position_freshness_archive` in §10 points to this file.

## 5. What if freshness fails?

If Phase 2 measurement shows freshness violates the §3.4 criteria, the options are:

1. **Park v2** — without reliable queue position, the cancellation-aware policy cannot operate safely. v3 would need a queue model that does not require real-time staleness reads (e.g., position-derived purely from local order-book reconstruction + WS trade stream — equivalent to the "primary_queue_model = conservative_threshold" branch in v2 §10.1).
2. **Switch primary queue model to "conservative_threshold"** at lock time — uses WS-derived queue estimate, not the REST endpoint. This degrades the policy to v1-style queue-naivety but with a known conservative bias. Catastrophic back-of-queue stress (§10.3) becomes the binding constraint.

The choice between (1) and (2) is itself a policy decision that must be reflected in the locked preregistration's §10.1. The current draft prefers `actual_queue_position_api` and falls back to `conservative_threshold`; if Phase 2 fails, the preregistration's §10.1 choice must be re-evaluated **before** lock (this is allowed because v2 is still `Status: DRAFT`).

## 6. Risks of Phase 2 measurement itself

The Phase 2 measurement places one real order. Even at $0.05 exposure, this:

- requires KALSHI_ALLOW_ORDERS=1 for the dummy placement (a state change from current `0`)
- creates a small but non-zero risk of unexpected fill at deep-OTM (BTC spot moves to the price; market then resolves YES; we lose $0.05)
- exposes the operator account to API surface that the strategy code does not yet use safely
- counts as a *live order* under any strict reading of the "no live trading" rule

Mitigations:

```text
- Dummy order is placed manually via the Kalshi web UI or a one-off CLI
  script, NOT via the polyterminal worker. The worker's KALSHI_ALLOW_ORDERS
  remains pinned to 0 throughout.
- A separate Kalshi account (sandbox or a freshly-funded throwaway with
  $1-$2 deposit) is used so the measurement cannot interact with the
  main bankroll.
- The measurement script is independent code, not part of v2's
  scoring pipeline. It does not see (and cannot influence) any v2
  parameters.
- The measurement is performed BEFORE v2 is locked, so its results
  can inform §10.1 choices without violating no-tuning-on-validation
  (the freshness is observable, not the holdout PnL).
```

Operator must explicitly authorize this small live order in a separate decision step before Phase 2 begins. This document does not authorize it.

## 7. Pre-lock checklist

Before the v2 preregistration may be locked:

```text
[x] Methodology specified (this file, §3)
[x] Pass criteria specified (§3.4)
[x] Fallback path for freshness failure specified (§5)
[x] Risk profile of measurement itself documented (§6)
[ ] Phase 2 measurement complete OR §10.1 set to conservative_threshold path
[ ] Phase 2 numbers filled in §4 (if measurement was run)
[ ] Operator authorization recorded for the Phase 2 dummy order (if applicable)
```

The first three checkboxes are sufficient for v2 lock — the empirical measurement is a canary prerequisite, not a lock prerequisite, **as long as §10.1 is set to a path that doesn't require live queue reads** (i.e., `conservative_threshold` or `back_of_queue`).

If v2 wants to lock with `primary_queue_model = actual_queue_position_api`, then §4 of this file must be filled with passing measurements before the lock commit.

---

**Companion documents:** `kxbtc15m-v2-preregistration.md` (§10, §15), `CLAUDE.md` §Conventions.
