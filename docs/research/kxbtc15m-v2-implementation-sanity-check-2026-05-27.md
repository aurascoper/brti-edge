# `KXBTC15M_PASSIVE_MAKER_v2` — implementation sanity check

> # **IMPLEMENTATION SANITY CHECK — NOT VALIDATION**
>
> The numbers in this document are from running the v2 implementation
> against **design-window data** (the same logs used to inform v2's
> filter choices). They are recorded here to confirm:
>
> 1. The code matches the locked spec.
> 2. The pipeline executes end-to-end without error.
> 3. The filters produce the expected cell counts.
> 4. The cancel triggers fire.
> 5. The settlement labeling resolves.
> 6. The capped envelope's worst-case collateral accounting executes.
>
> They are **NOT** evidence about v2's edge. They are **NOT** a
> validation outcome. They will **NOT** be used to amend the spec. Per
> operator guardrail #4, the §13 Gate pass/fail logic is intentionally
> NOT computed in this report.

---

## 1. What this is and is not

**Is:** a code-correctness check. Per the locked preregistration
([`kxbtc15m-v2-preregistration.md`](kxbtc15m-v2-preregistration.md),
commit A `71216c6`, lock `e65a36b`), the implementation must conform
to the spec, and the sanity check is the mechanism for confirming
conformance before holdout collection begins.

**Is not:** validation. The holdout window
(`2026-06-02T00:00:00Z → 2026-06-12T00:00:00Z`) has not been collected
and was not consulted. Any apparent gate pass or fail in the numbers
below is an artifact of the design corpus and cannot be cited as
evidence about v2's likely holdout outcome.

**Bound by:** every ambiguity resolved during implementation (the
AD-1 … AD-6 decisions documented in `btcMakerV2.ts`'s header comment)
is binding for the holdout. No code-level decision recorded here may
be amended after the holdout score is published.

## 2. Run parameters

```text
date_local        = 2026-05-27 (US/Central)
date_utc          = 2026-05-27T12:Z
runner_v2         = pnpm run run-btc-maker-v2
runner_v2_capped  = pnpm run run-btc-maker-v2-capped
log_dir           = staged design-window union:
                    chunk_1: 2026-05-25T06 → 2026-05-26T13  (v1 in-sample 30.79h)
                    chunk_2: 2026-05-26T22 → 2026-05-27T08  (v1 shakeout 9.53h)
                    total: 215 hourly gzip files = 43 hours × 5 channels
label_v2          = sanity-check-design-window-chunks-2026-05-27
label_v2_capped   = sanity-check-capped-design-window-chunks-2026-05-27-FIXED
markets_indexed   = 164 KXBTC15M markets
candidate_anchors = 1,959 (60s cadence × eligible markets)
```

## 3. Implementation conformance: v2 (no cap)

### 3.1 Filter pipeline

```text
candidate anchors            : 1,959
filter rejects               : 1,850
posted (passed all filters)  :   109
```

Reject breakdown:

| reason | count | conforms to |
|---|---:|---|
| `tte_filter` | 811 | §7.5 (TTE ∉ [360s, 840s]) |
| `utc_hour_filter` | 654 | §7.6 (UTC hour ∉ [0..7]) |
| `moneyness_filter` | 244 | §7.8 (|touch − 0.50| ∉ [0.15, 0.40]) |
| `per_market_cap` | 86 | §9.2 (≤ 1 active quote per market) |
| `spread_floor` | 55 | §7.7 (spread < 1 tick) |
| (sum) | **1,850** | matches reject total ✓ |
| `inventory_cap` | 0 | §9.1 (≤ 2 net directional) — not binding at this scale |

Sanity-check verdict: the filter math is internally consistent and
each filter fires for a non-trivial fraction of anchors, indicating
the filter logic is operative.

### 3.2 Cancel-trigger pipeline (posted quotes only)

```text
posted quotes                : 109
filled (no cancel triggered) :  21
spread_widen cancelled       :  77
queue_deterioration cancelled:  11
ttl expired                  :   0
level depleted               :   0
market terminated            :   0
```

Sanity-check verdict: both v2-specific cancel triggers
(`cancel_on_spread_widen`, `cancel_on_queue_deterioration`) fire as
expected. `spread_widen` is the dominant trigger — consistent with
the thin 15-minute Kalshi book that motivated those triggers in the
first place.

The AD-1 and AD-2 operational definitions are now binding for the
holdout:

- **AD-1**: `spread_widen` fires when `current_spread_ticks >
  spread_at_post_ticks + 1`. Spread = `best_yes_ask − best_yes_bid`
  in tick units (1 cent).
- **AD-2**: under conservative_threshold, `queue_deterioration` fires
  when `best_yes_bid` strictly increases past our quote price (touch
  moved better; we are no longer at the touch).

### 3.3 Settlement labeling

```text
records with settlement label : 109 (100%)
settlement confidence "high"  : (per inferSettlement: S ≥ 0.97 or S ≤ 0.03)
settlement confidence "low"   : (last mid used; market never resolved cleanly)
settlement confidence "none"  : 0 — no orphaned records
```

Settlement inference works for all posted quotes in the design window.
The `inferSettlement` function is duplicated identically between
`btcMakerV2.ts` and `btcMakerV2Capped.ts` and matches v1's logic.

### 3.4 PnL & concentration (NOT GATES on this run)

```text
EV per posted   = -$0.0088 (-0.881¢)
EV per filled   = -$0.0457 (-4.571¢)
total PnL       = -$0.96 across 21 fills
fill rate       = 19.3%
distinct markets w/ ≥1 fill = 21
```

| metric | value | reference §13 threshold |
|---|---|---|
| top-1 market |PnL| share | 14.3% (`KXBTC15M-26MAY252215-15`) | Gate 5: ≤ 25% |
| top-1 2h-block |PnL| share | 15.6% (`2026-05-26T06`) | Gate 5: ≤ 40% |
| top-1 hour-of-day share | 17.2% (UTC hour 0) | Gate 5: ≤ 40% |
| distinct markets w/ ≥1 fill | 21 | Gate 2: ≥ 20 |

**These are diagnostic metrics, not gate verdicts.** The §13 thresholds
are shown for orientation only. The gate verdict logic is
intentionally NOT executed in this report — the report-renderer
checks `args.label.includes("holdout")` before computing pass/fail.

### 3.5 Bucket-level break-down (diagnostic; matches AS scorer cell expectations)

```text
TTE 6-9min:    36 posted,  4 filled, EV/posted +$0.0119
TTE 9-12min:   45 posted, 13 filled, EV/posted -$0.0327
TTE 12-15min:  28 posted,  4 filled, EV/posted +$0.0029
UTC 00-04Z:    34 posted,  7 filled, EV/posted -$0.0159
UTC 04-08Z:    75 posted, 14 filled, EV/posted -$0.0056
```

The TTE breakdown roughly mirrors the AS scorer's design-data cell
signs (6-9 and 12-15 positive, 9-12 negative). This is the expected
shape — and it confirms the v2 implementation's TTE bucketing matches
the AS scorer's. (If TTE were misaligned, the cell signs would
shift.) **Note again: this is design-data conformance, not a
predictor of holdout behavior.**

## 4. Implementation conformance: v2 capped

### 4.1 Cap admission funnel

```text
candidate anchors                          : 1,959
blocked by policy filters                  : 1,850
passed policy filters                      :   109
allowed by cap envelope                    :   109
— blocked by cap: quote_size_cap           :     0
— blocked by cap: exposure_cap             :     0
— blocked by cap: bankroll_exhausted       :     0
allowed & filled                           :    21 (19.3% of allowed)
```

The cap envelope was not binding on this dataset: every quote that
passed the policy filters also passed the $1 quote / $5 locked /
$25 bankroll cap. This is expected for a design window in which the
strategy posted only 109 quotes over 43 hours of observable data —
cap utilization averaged 0.8% of the $5 locked-collateral limit.

The cap admission code path is exercised (`decideCapAdmission`
returned `allowed=true` 109 times), even though no quote was
rejected. The cap-block code paths
(`quote_size_cap`, `exposure_cap`, `bankroll_exhausted`) were not
exercised on this dataset — they would require either a higher quote
notional, more open positions, or a deeper drawdown than v2 produces
on the design window. Synthetic edge-case unit tests for those
branches should be added before holdout if higher confidence is
required (the operator's guardrail #4 suggests synthetic edge-case
data for any gate-logic verification, which applies here as well).

### 4.2 P&L and drawdown

```text
starting bankroll     : $25.0000
ending bankroll       : $24.0400      # = $25 − realized PnL of $0.96 ✓
realized PnL          : -$0.9600
EV per allowed posted : -$0.0088
EV per allowed filled : -$0.0457
max drawdown          : $2.4300 (9.7% of starting bankroll)
```

The bankroll math is internally consistent (`starting − ending =
realized PnL`). Max drawdown of $2.43 is computed on the cash
trajectory at SETTLE events (matching v1Capped's documented
"realized-only, computed from the cash trajectory at SETTLE events"
semantics). Mark-to-market dips during open-position lifetime are
NOT counted in drawdown.

**§13 Gate 4 (drawdown ≤ 20% / $5) is NOT a verdict on this run.**
The value is reported as a metric only. If applied as a verdict, the
data-window observed drawdown of 9.7% / $2.43 would technically
satisfy Gate 4 — but the holdout outcome may be entirely different
because the design data is a known overfit-risk corpus.

### 4.3 Implementation bug found and fixed during the sanity check

During the first run of the capped sanity check, the bankroll math
was inconsistent: ending bankroll $15.08 vs expected $24.04 (off by
~$9). Root cause: the initial implementation deducted collateral
from bankroll at fill AND added PnL at settle, but did **not**
return the locked collateral at settle — a double-deduction.

**Resolution per operator guardrail #1:** the code was fixed; the
spec was **NOT** amended. The fixed model matches v1Capped's
documented semantics (bankroll = cash position; changes only by
realized PnL at SETTLE; open-position collateral is tracked
separately for `decideCapAdmission`'s exposure_cap check, not
deducted from bankroll). Spec §8 was not consulted for, and did
not contribute to, the fix decision.

The fix was applied at the source code of `btcMakerV2Capped.ts`
(commit `<filled at commit time>`); the sanity check was re-run
against the same staged design-window data; the output above
reflects the corrected math.

### 4.4 Capital utilization & exposure duration

```text
active window           : 73.33 h
time-avg worst-case locked : $0.0393
utilization              : 0.8% of $5 cap
filled positions        : 21
mean position duration  : 629.6 s
max position duration   : 804.1 s
```

Exposure duration is bounded by TTE (positions are held to
settlement; mean of 629.6s = 10.5 min ≈ middle of the [6, 14] min
TTE window). The 804.1s max is just over the 12-15min TTE bucket's
upper bound, consistent with positions held to market settlement.

## 5. Conformance summary

| spec requirement | implementation status |
|---|---|
| §6 series = KXBTC15M only | ✓ enforced by `isBtcMarket` |
| §7.1 yes_only_guarded | ✓ `SIDE = "yes" as const`, `SIZE_CONTRACTS = 1` |
| §7.3 quote_price_rule = at_touch | ✓ `priceDollars = best_yes_bid(state)` at anchor |
| §7.4 quote_duration_seconds = 75 | ✓ `QUOTE_DURATION_MS = 75_000` |
| §7.4 cancel_on_spread_widen | ✓ AD-1 binding definition (1 tick threshold) |
| §7.4 cancel_on_queue_deterioration | ✓ AD-2 binding definition (touch-moved) |
| §7.4 cancel_before_expiry = 60s | ✓ implicit (TTE filter min = 360s ≫ 60s) |
| §7.5 TTE filter [360s, 840s] | ✓ `TTE_MIN_MS = 360_000`, `TTE_MAX_MS = 840_000` |
| §7.6 UTC hours 00-08Z | ✓ `ALLOWED_UTC_HOURS = {0..7}` |
| §7.7 min_spread_ticks = 1 | ✓ `MIN_SPREAD_TICKS = 1` |
| §7.7 max_spread_ticks = disabled | ✓ no upper-bound check in filters |
| §7.8 moneyness ∈ [0.15, 0.40] | ✓ `MONEYNESS_MIN/MAX` constants |
| §8 starting_bankroll = $25 | ✓ `CAPS.bankrollDollars = 25.0` |
| §8 max_quote = $1 | ✓ `CAPS.maxQuoteCollateralDollars = 1.0` |
| §8 max_total_locked = $5 | ✓ `CAPS.maxTotalLockedCollateralDollars = 5.0` |
| §8 worst-case collateral acct | ✓ `decideCapAdmission` uses `maxLossOf(pos)` |
| §8 hold-to-settlement clause | ✓ no taker exits; open positions account at max_loss |
| §9.1 max_net_directional = 2 | ✓ `MAX_NET_DIRECTIONAL_CONTRACTS = 2` |
| §9.2 max_contracts_per_market = 1 | ✓ `per_market_cap` reject at post time |
| §10.1 conservative_threshold | ✓ `QUEUE_ASSUMPTION = { type: "back" }` (queueModel's back-of-queue) |
| §10.2 deterministic fill rule | ✓ no probabilistic coefficients are fit |
| §13 gate logic | ✓ gated behind `isHoldoutRun` flag — only computed on `holdout` labels |

## 6. Carry-forward: locked code-level decisions

The following decisions made during implementation are now binding
for the holdout and any subsequent v2 scoring. They are documented
in `btcMakerV2.ts` header comment block AD-1 … AD-6:

- **AD-1** `spread_widen`: current_spread_ticks > spread_at_post_ticks + 1
- **AD-2** `queue_deterioration` (under conservative_threshold):
  best_yes_bid moves strictly higher than our post price
- **AD-3** `inventory_cap`: post-time check on filled-unsettled count
- **AD-4** `per_market_cap`: any open or alive quote on same market_ticker
- **AD-5** `settlement_time`: last bookEvent.tsMs for the market
- **AD-6** `level_depleted` from queueModel.ts is treated as a cancel
  event (slightly more conservative than the literal spec language)

Plus one implementation-bug-fix decision recorded during this
sanity check:

- **IBF-1** bankroll math: changes ONLY at SETTLE by realized PnL;
  collateral commitment is NOT deducted at fill (tracked separately
  in `cap.openPositions` for `decideCapAdmission`'s exposure_cap
  check). Matches v1Capped's documented semantics.

## 7. What's next

1. **Wait for holdout collection** to begin (≥ 2026-06-02T00:00:00Z).
2. **Stage the holdout logs** in a clean directory, distinct from
   any design-window file.
3. **Run `pnpm run run-btc-maker-v2 --log-dir=<holdout> --label=holdout-<date>`** exactly once.
4. **Run `pnpm run run-btc-maker-v2-capped --log-dir=<holdout> --label=holdout-<date>`** exactly once.
5. **Run the adequacy report** to confirm `continuous_holdout_eligible = true`
   (Gate 1) and reach §5.2 sample-size minimums (Gate 2).
6. **Combine the three reports** into the final pass/fail memo per §16
   of the preregistration.
7. **Archive the running commit hash** alongside the holdout score per
   the operator's added step #6 from 2026-05-27.

The v2 implementation is now ready to score a holdout when one
exists. The spec is locked, the code matches the spec, the
ambiguities are resolved, and the sanity check has confirmed the
pipeline executes correctly end-to-end.

---

**End of sanity-check artifact.** No live orders authorized. No
gate verdict computed. The locked preregistration is the binding
authority; this document is its conformance receipt.
