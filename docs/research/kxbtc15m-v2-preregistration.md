# Pre-registration: `KXBTC15M_PASSIVE_MAKER_v2`

**Status:** **DRAFT — NOT YET LOCKED**
**Created:** 2026-05-27
**Policy version:** `KXBTC15M_PASSIVE_MAKER_v2`
**Repository:** `aurascoper/brti-edge`
**Commit hash at preregistration:** `<fill at lock time>`
**Author/operator:** `<fill>`
**Frozen after commit:** Once committed with `Status: LOCKED`, no parameter, threshold, gate, data window, queue assumption, or fee assumption may be changed. While `Status: DRAFT`, this file may be edited freely; it carries no validation authority.

> **This document does not authorize any live Kalshi orders.** A locked version of this preregistration is a *prerequisite* for any future canary discussion; it is not itself a license.

---

## 1. Purpose

Test whether a passive limit-order strategy on Kalshi BTC 15-minute binary contracts (`KXBTC15M`) can earn positive **settlement EV** after realistic queue position, non-fill, adverse-selection, drawdown, concentration, and fee accounting.

Strict wall between *design* and *validation*:

```text
Design data    = data used to choose this policy.
Validation     = unseen holdout data used ONCE for final pass/fail.
```

This document is execution-side only. No signal-side autoresearch, no Brier feature search, no basis/funding/perp/OFI/OU/residual-momentum work, no taker exits, no R7-style live trading is reopened.

## 2. Prior results motivating v2

`BTC_YES_LATE_ASIA_v1` is not live-tradeable from current evidence.

Known v1 failure modes (sources: §13.8 in-sample exploratory + §13.11 non-holdout shakeout):

```text
- in-sample run (30h, 2026-05-25/26):
  - EV/posted +2.00¢ on 362 quotes; gates 1-4, 6, 7 passed
  - Gate 5 failed in-sample (top-1 market 58.7%) — concentration warning
- non-holdout shakeout (9h 32m, 2026-05-26→27):
  - settlement PnL = -$4.26 across 282 posted / 142 filled
  - EV/posted = -1.5¢; EV/filled = -3.0¢
  - $25 capped replay: max drawdown $12.64 (50.6% of bankroll)
  - Gate 5: 94.5% (one market dominated)
  - Gate 6: 122.0% (one 2h block exceeded the absolute sum)
  - 9 of 7 gate sub-checks failed
- prior 6-round live history (R1-R6, 2026-05-15 → 2026-05-17):
  - 285 filled trades, net -$32.99
  - R3 +$9.48 vs R6 +$2.67 not statistically distinguishable (Fisher p = 0.37)
```

The 9.5h shakeout is now **part of the design corpus**, not a validation set. It may inform v2 structure; it may not serve as v2's validation.

## 3. Hard prohibitions

This v2 policy may **not** use or reopen:

```text
- new fair-value signal research
- Brier feature search beyond what is already in the repo at lock time
- basis/funding/perp autoresearch
- OU mean reversion as a signal
- residual momentum as a standalone signal
- same-week or short-window validation
- post-hoc gate relaxation
- live R7-style taker trading
- any extension of the policy to other series (ETH, SOL, etc.)
```

Adding any of the above requires a separate preregistration (v3+) on a fresh data sample.

## 4. Fee assumption

### 4.1 Maker fee

For `KXBTC15M`, the maker fee assumption is:

```text
maker_fee_rate = 0.00
```

**Supporting evidence already archived** (claude-mind memory `kalshi-ou-characterization-2026-05-25` HIT, tag `fee-schedule-correction`): Kalshi fee schedule PDF + help center + laikalabs comparison + CFTC filing references all confirm $0 maker fee for the `KX*15M` crypto markets. This supersedes the earlier "up to 1% rebate" framing.

Before lock, archive the source as a static markdown reference:

```text
Fee schedule archive: <fill, target: docs/research/kalshi-fee-assumption-kxbtc15m.md>
PDF retrieved on:     <fill date>
PDF SHA-256:          <fill>
```

If the archive is missing at lock time, this preregistration is invalid.

### 4.2 Taker fee

This v2 policy is maker-only:

```text
taker_exits_allowed = false
taker_fee_applied   = N/A
```

Adding taker exits requires a new preregistration.

## 5. Data windows

### 5.1 Design window

```text
design_window_start_utc = <fill>
design_window_end_utc   = <fill>
included_runs:
- v1 in-sample exploratory (30h, 2026-05-25/26)
- non-holdout shakeout (9h 32m, 2026-05-26→27)
- prior collector artifacts in apps/data-collector/logs/
```

Design data may be used for parameter search and hypothesis generation.

### 5.2 Validation holdout window

```text
holdout_window_start_utc = <fill, must be >= 2026-06-02T00:00:00Z>
holdout_window_end_utc   = <fill>
minimum_expected_hours   = 30
distinct_calendar_week   = true
```

**Strict non-overlap rule (NEW in v2):**
> No second of the holdout window may overlap with ANY design-window run, including the v1 30h in-sample capture, the v1 shakeout, any exploratory collector artifact in `apps/data-collector/logs/`, or any subsequent draft-tuning work. If even one hour bucket overlaps, the holdout is invalid and this preregistration cannot be scored against it.

Eligibility (per `apps/data-collector/src/adequacyReport.ts` `isContinuousHoldoutEligible`):

```text
expected UTC hour buckets >= 30
worst-channel coverage    >= 99%
worst-channel longest missing-hour gap <= 1h
continuous_holdout_eligible = true (required)
```

## 6. Instruments and markets

```text
series       = KXBTC15M only
underlying   = BTC
contract     = Kalshi 15-minute binary event contract
settlement   = exchange-resolved YES/NO outcome (BRTI-implied per §13)
```

## 7. Policy definition

### 7.1 Quoting mode

```text
quoting_mode = <one of:
  two_sided_inventory_guarded   (default recommendation)
  yes_only_guarded
  no_only_guarded
>
```

Recommended default: `two_sided_inventory_guarded`. Rationale: v1 YES-only created directional exposure; the prior NO-bid drag in `BTC_TOUCH_DEPTH50` is the failure to address, not the failure to avoid.

### 7.2 Quote side rules

```text
post_yes_bid = <true|false>
post_no_bid  = <true|false>
yes_size_contracts = <fill>
no_size_contracts  = <fill>
```

If one side is disabled, justify from microstructure logic, not PnL slicing:

```text
disabled_side = <YES|NO|none>
reason        = <microstructure justification>
```

### 7.3 Quote price

```text
quote_price_rule = <fill>   # e.g. at_touch | one_tick_behind_touch | only_when_spread_ge_N_ticks
```

### 7.4 Quote duration / cancellation

```text
quote_duration_seconds          = <fill>
cancel_on_spread_widen          = <true|false>
cancel_on_queue_deterioration   = <true|false>
cancel_on_inventory_breach      = true   # required
cancel_before_expiry_seconds    = <fill>
```

Cancellation-aware replay is mandatory. A quote that would have been cancelled by the policy must not receive a ghost fill in the replay.

### 7.5 Time-to-expiry filter

```text
tte_min_seconds = <fill>
tte_max_seconds = <fill>
```

Justification (microstructure-grounded, not PnL-grounded):

```text
<fill>
```

The literature is consistent that adverse selection intensifies as TTE → 0 (information arrivals become discontinuous near resolution; spread cannot be repriced fast enough). v2 should be more conservative as TTE → 0.

### 7.6 Time-of-day filter

```text
allowed_utc_hours = <fill, e.g. [0..23] for no filter, [20..23,0..7] for late-Asia>
```

Justification:

```text
<fill: first-principles explanation OR mark as exploratory>
```

If selected from design-window PnL slicing alone (no microstructure reason), label as `exploratory_only` and stress-test under the concentration gate.

### 7.7 Spread filter

```text
min_spread_ticks = <fill>
max_spread_ticks = <fill>
```

### 7.8 Moneyness filter (binary-contract-specific)

For binary contracts with payoff ∈ {0,1}, "moneyness" is defined as distance of the touch price from `0.50`:

```text
moneyness_metric        = |touch_price - 0.50|
allowed_moneyness_range = <fill, e.g. [0.10, 0.40] to quote between 0.10 and 0.40 away from 0.50>
```

If disabled:

```text
moneyness_filter = disabled
```

Reviewer note: a literal "moneyness" notion for binaries is ill-defined; the distance-from-0.50 proxy is the conventional substitute. Define it explicitly at lock to avoid ambiguity.

## 8. Capital and risk envelope

Live-like replay must use:

```text
starting_bankroll_usd            = 25.00
max_quote_collateral_usd         = 1.00
max_total_locked_collateral_usd  = 5.00
```

**Collateral accounting (worst-case):**

```text
locked_collateral
  = posted_unfilled_reserved
  + filled_open_exposure_worst_case
```

where:

```text
posted_unfilled_reserved
  = sum over all unfilled quotes of (price_dollars × size_contracts)
  # assume 100% fill possibility — the worst-case reservation

filled_open_exposure_worst_case
  = sum over all filled-but-unsettled positions of max_loss(position)
  # YES-bid at $P_y, size N: max_loss = P_y × N (all-zero settlement)
  # NO-bid at $P_n, size N:  max_loss = P_n × N (all-one settlement, NO loses)
```

**Worst-case applies even if the strategy is hold-to-settlement.** A filled-but-unsettled position consumes its full `max_loss` against the locked-collateral cap until settlement, regardless of current mark-to-market value or the policy's intent not to take an early exit. Mark-to-market accounting is not permitted for cap purposes — it would silently let the strategy stack more exposure than the $5 envelope contemplates whenever positions are in the money.

The replay must enforce `locked_collateral <= max_total_locked_collateral_usd` at quote-emission time. Quotes that would breach the cap are rejected as `exposure_cap`.

**Drawdown is tracked separately** from exposure (drawdown measures realized + mark-to-market on the cash trajectory, not locked-collateral usage):

```text
max_replay_drawdown_usd = 5.00
max_replay_drawdown_pct = 20%
```

If drawdown exceeds this gate at any point, v2 fails — even if final EV is positive.

## 9. Inventory controls

### 9.1 Net directional exposure

```text
max_net_yes_contracts          = <fill>
max_net_no_contracts           = <fill>
max_net_directional_contracts  = <fill, suggested <= 2>
```

### 9.2 Per-market exposure

```text
max_contracts_per_market      = <fill>
max_collateral_per_market_usd = <fill>
max_pct_bankroll_per_market   = 10%
```

### 9.3 Inventory stop

```text
stop_quoting_when_inventory_exceeds_limit = true
resume_when_inventory_back_within_limit   = true
```

## 10. Queue-position model

Kalshi exposes queue position via `GET /portfolio/orders/{order_id}/queue_position`. Per [Kalshi API docs](https://docs.kalshi.com/api-reference/orders/get-order-queue-position) (verified 2026-05-27):

> `queue_position_fp`: "The number of preceding shares before the order in the queue." Queue position is determined using **price-time priority**.

**Operational risk flagged at preregistration time:** the Kalshi documentation does **not** specify how frequently `queue_position_fp` updates, the latency between actual queue changes and the observable field, nor any subscription/streaming mechanism. For live use, queue staleness could materially affect cancellation decisions. Before any live canary, an empirical freshness measurement must be archived:

```text
queue_position_freshness_archive = <fill, target:
  docs/research/kalshi-queue-position-freshness.md>
```

### 10.1 Primary queue assumption

```text
primary_queue_model = <one of:
  actual_queue_position_api   (preferred for live; for replay only if reconstructable)
  conservative_threshold      (fill allowed when queue_position_fp <= N)
  depth_fraction_50           (used in v1; under-conservative)
  depth_fraction_75
  back_of_queue
>
```

Recommended: `actual_queue_position_api` for live; for replay, use `conservative_threshold` derived from the queue model in `apps/data-collector/src/replay/queueModel.ts`.

### 10.2 Queue mapping

If using actual queue position:

```text
queue_position_field                 = queue_position_fp
fill_allowed_when_queue_position_fp <= <fill threshold N>
```

If using an empirical fill probability model:

```text
P(fill within quote_duration) =
  f(queue_position_fp, visible_depth, time_to_expiry, spread_ticks, recent_trade_intensity)
```

Model form:

```text
<fill exact formula — e.g.:
  P_fill = base × exp(-depth_factor × visible_depth)
                × (1 - exp(-time_factor × time_remaining))
                × queue_decay(queue_position_fp)>
```

Coefficients:

```text
<fill all coefficients>
```

Training data window (must NOT overlap holdout):

```text
<fill>
```

**No coefficient may be fit on the validation holdout.**

### 10.3 Queue stress scenarios

The replay must report PnL under three queue-position scenarios:

```text
front_of_queue:
  Assume immediate fill whenever the simulated quote is at the touch
  and any trade occurs at that price level. Queue position is ignored
  (treated as 0 preceding shares). This is an unrealistic best-case
  upper bound used only for comparison.

primary_queue_model:
  As defined in §10.1-10.2. This is the official pass/fail scenario.

back_of_queue:
  Assume the simulated quote joins the queue AFTER all existing shares
  at that price level (queue_position_fp_t0 = visible_depth_t0). A fill
  is only credited if subsequent trades at that price level total at
  least visible_depth_t0 + own_size, AND the price level hasn't been
  removed by cancels before that happens. This is the conservative
  lower bound.
```

**Official pass/fail gates apply to the primary scenario.** Catastrophic failure conditions:

```text
catastrophic_back_of_queue:
  back_of_queue_ev_per_posted < -0.01      # 1¢/posted lower bound; default
  OR back_of_queue_drawdown_pct > 30%

OR:
  passes_only_under_front_of_queue == true
```

> **Reviewer note on the catastrophic threshold:** the default −1¢/posted is stricter than the −0.5¢ floated in earlier draft. Rationale: at a $1 notional and ~1 candidate-per-90s rate, −1¢/posted ≈ −$9.60/day expected loss — already past the $5 drawdown gate within a single trading day. Alternative formulation: catastrophic if back-of-queue EV flips sign *and* exceeds 1× the primary EV in absolute magnitude. Lock the chosen threshold before holdout.

## 11. Fill and non-fill accounting

All posted quotes must be included in the denominator.

```text
ev_per_posted = total_settlement_pnl / total_posted_quotes
ev_per_filled = total_settlement_pnl / total_filled_quotes
```

Non-fills:

```text
unfilled_quote_pnl                     = 0
unfilled_quote_counts_in_denominator   = true
reserved_collateral_duration_recorded  = true
```

Cancelled quotes:

```text
canceled_quote_pnl                     = 0
canceled_quote_counts_in_denominator   = true
ghost_fills_after_cancel               = forbidden
```

## 12. Markout and settlement metrics

For every fill, report:

```text
markout_5s
markout_15s
markout_30s
markout_60s
settlement_pnl
```

Per [Kalshi public trades docs](https://docs.kalshi.com/websockets/public-trades) (verified 2026-05-27), trade messages include both `taker_outcome_side` (yes|no) and `taker_book_side` (bid|ask), and are *"sent immediately after trade execution"*. Use venue-provided direction — `taker_outcome_side` is the canonical field for the side-of-the-aggressor. Do not infer direction from quote movement (Lee-Ready or similar). The Dubach (2026) Polymarket result on inferred-vs-on-chain direction agreement is ~59% — well below useful — and the Kalshi venue field eliminates this measurement error entirely.

Failure condition:

```text
markout positive but settlement negative in aggregate
```

Interpretation: temporary spread/markout capture is reversing before settlement. This is the v1 failure mode and must be flagged as a structural fail of v2 if observed.

## 13. Pass/fail gates

All gates must pass on the official holdout for v2 to pass.

### Gate 1 — Holdout eligibility

```text
continuous_holdout_eligible == true
no design-window overlap    == true
```

### Gate 2 — Sample size

```text
posted_quotes    >= 500
filled_quotes    >= 200
distinct_markets >= 20
```

### Gate 3 — Settlement EV

```text
ev_per_posted    > 0
ev_per_filled    > 0.01    # 1¢ floor; must clear adverse selection
ending_bankroll  >= starting_bankroll
```

### Gate 4 — Drawdown

```text
max_drawdown_usd <= 5.00
max_drawdown_pct <= 20%
```

### Gate 5 — Concentration

```text
top_1_market_abs_pnl_share         <= 25%
top_1_tte_bucket_abs_pnl_share     <= 35%
top_1_utc_hour_abs_pnl_share       <= 40%
top_1_2h_window_abs_pnl_share      <= 40%
```

### Gate 6 — Side decomposition

If two-sided:

```text
yes_side_ev_per_posted > 0
no_side_ev_per_posted  >= 0    # strict default per reviewer memo
```

> **Reviewer note on the NO-side gate:** `>= 0` is a deliberately high bar — it requires the NO side to be independently viable, not subsidized by the YES side. An alternative is `> -0.002 AND total_ev_per_posted > 0`, which permits a small NO cost in exchange for inventory neutrality. Lock the chosen formulation before holdout. If you keep `>= 0`, document the risk that a net-profitable two-sided strategy could be rejected because its NO leg is a small but necessary inventory-management drag.

If one-sided:

```text
directional_exposure_justification_present     = true   # microstructure, not PnL
max_net_directional_contracts_gate_passed      = true
```

### Gate 7 — Queue robustness

```text
primary_queue_model_ev_per_posted     > 0
primary_queue_model_drawdown_pct      <= 20%
front_of_queue_ev_per_posted          reported
back_of_queue_ev_per_posted           reported
```

Fail if `catastrophic_back_of_queue == true` per §10.3, or if the policy passes only under `front_of_queue`.

### Gate 8 — Non-fill / cancel integrity

```text
non_fills_in_denominator   = true
cancellations_modeled      = true
ghost_fills_after_cancel   = 0
```

### Gate 9 — No post-hoc tuning

```text
policy_commit_hash                        == preregistration_commit_hash
no_parameter_changes_after_holdout_start  == true
```

## 14. Rejection rules

v2 is **permanently rejected** if:

```text
- official holdout fails any gate above
- live canary (if ever authorized) hits the 25% stop loss
- three distinct preregistered variants fail
- replay PnL depends on a single market or time bucket
- queue stress flips EV catastrophically negative
- any subsequent literature finding shows passive maker profitability
  on binary event contracts is structurally negative
```

After permanent rejection, no v3+ of this concept may be tested without a new pre-registration on a fresh sample.

## 15. Live canary eligibility

**Live canary is NOT authorized by this document.**

A future live canary may be proposed only if all holdout gates pass. Minimum canary constraints (must be re-confirmed at canary-launch time):

```text
capital_cap_usd                       = 25
max_quote_collateral_usd              = 1
max_total_locked_collateral_usd       = 5
hard_stop_loss_usd                    = 5     # 20% of bankroll, matches drawdown gate
maker_only                            = true
taker_exits_allowed                   = false
manual_kill_switch_required           = true
dry_run_order_cancel_path_passed      = true  # already validated 2026-05-27
queue_position_freshness_validated    = true  # required NEW work, see §10
```

Canary must terminate immediately if:

```text
- realized drawdown >= $5
- any taker order is sent
- queue_position_fp API unavailable for > 60s
- stale book state detected
- duplicate worker / collector process detected
- settlement mismatch (Kalshi resolution differs from local replay expectation)
- unexpected fee charged
```

Minimum canary duration: **≥ 200 filled quotes OR 14 calendar days, whichever is longer.**

## 16. Required outputs after holdout scoring

The holdout scoring run must produce:

```text
1. adequacy report (apps/data-collector/src/adequacyReport.ts)
2. queue model validation (apps/data-collector/src/replay/validateQueueModel.ts)
3. v2 replay report (new: apps/data-collector/src/replay/btcMakerV2.ts)
4. capped replay report (new: btcMakerV2Capped.ts, matches §13.10 pattern)
5. side decomposition table
6. concentration table (by market, TTE, hour, 2h window)
7. drawdown curve
8. final pass/fail memo (one document, single binary verdict per gate)
```

All eight outputs are required regardless of whether v2 passes or fails.

## 17. Final declaration before lock

Before changing `Status:` from `DRAFT` to `LOCKED`, ALL of the following must be filled with `YES`:

```text
All policy parameters specified         : YES / NO
All gates specified                     : YES / NO
Design window specified                 : YES / NO
Holdout window specified                : YES / NO
Queue model specified                   : YES / NO
Fee assumption source archived          : YES / NO
Queue-position freshness archive present: YES / NO
No validation data inspected for v2     : YES / NO
front_of_queue, back_of_queue defined   : YES / NO
catastrophic threshold locked           : YES / NO
side-decomposition gate formulation locked : YES / NO
moneyness metric explicit               : YES / NO
```

If any field is `NO`, the lock is rejected.

## 18. Commit record (filled at lock time)

```text
preregistration_commit  = <fill>
policy_code_commit      = <fill>
scoring_code_commit     = <fill>
data_collector_commit   = <fill>
```

## 19. Operator sign-off (filled at lock time)

```text
I understand that after this document is committed with Status: LOCKED,
no v2 parameter, gate, queue assumption, fee assumption, or data window
may be changed before the holdout score is published.

operator_name = <fill>
timestamp_utc = <fill>
signature     = <fill>
```

---

## Appendix A — Refinement provenance

This draft incorporates the following refinements over the initial template:

| # | Refinement | Section | Source |
|---|---|---|---|
| 1 | `front_of_queue` defined concretely | §10.3 | reviewer memo 2026-05-27 |
| 2 | Catastrophic back-of-queue tightened to −1¢/posted | §10.3 | reviewer memo 2026-05-27 |
| 3 | Strict non-overlap of holdout vs design data | §5.2 | reviewer memo 2026-05-27 |
| 4 | NO-side decomposition gate trade-off documented | §13 Gate 6 | reviewer memo 2026-05-27 |
| 5 | Moneyness defined as `|touch - 0.50|` for binaries | §7.8 | reviewer memo 2026-05-27 |
| 6 | Collateral worst-case accounting made explicit, incl. hold-to-settlement positions | §8 | reviewer memo 2026-05-27 (full tail received) |
| 7 | `taker_outcome_side` (verified field name) | §12 | Kalshi public-trades docs, verified 2026-05-27 |
| 8 | Queue-position freshness operational risk flagged | §10 | Kalshi queue endpoint docs, verified 2026-05-27 |
| 9 | Fee source already archived (claude-mind memory) | §4.1 | memory `kalshi-ou-characterization-2026-05-25` |

Reviewer status as of 2026-05-27: *"as rigorous as any academic preregistration I've reviewed for small-scale execution strategies. Green light to proceed — provided you do not inspect the holdout data before locking."*

## Appendix B — Open items before lock

```text
- Queue-position freshness measurement does not yet exist; must be
  archived to docs/research/kalshi-queue-position-freshness.md before
  any canary discussion (template §10 requires this).
- Fee schedule archival doc does not yet exist as a static file in repo
  (claim is sourced via memory only); must be archived to
  docs/research/kalshi-fee-assumption-kxbtc15m.md before lock.
- All <fill> fields in §5, §7, §9, §10, §18, §19 must be completed
  using ONLY design-window data and reasoning — no holdout-window
  inspection prior to lock.
```

---

**End of draft.** Status remains `DRAFT — NOT YET LOCKED`. No live orders authorized.
