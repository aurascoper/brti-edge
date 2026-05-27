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

### 2.1 Structural risk from the literature — KXBTC15M is a single-name market

Adverse-selection research on Kalshi (Stanford, 2026; 41.6M Kalshi trades) finds that *"one-sided order flow predicts maker losses in single-name markets but not broad-based markets,"* and that the maker premium in single-name markets is sustained by a behavioral surplus: *"traders systematically overbet YES in markets that predominantly settle NO."*

KXBTC15M is a single-name market, and v2 is one-sided by design (YES-only — see §7.1). This creates a structural tension between v2's quoting choice and the general finding:

- The §7.1 microstructure rationale (AS scorer table C side decomposition: YES +0.905¢/posted vs NO −0.218¢/posted, every component flipping sign except residual) explains *why* YES specifically works on the design-window tape.
- The Stanford finding explains *why this regime is fragile*: the YES-side edge depends on a behavioral flow that could shift if the underlying YES-overbetting behavior changes.

**Operational implication for the holdout:** the evidence bar for a one-sided single-name strategy is *higher*, not lower, than for a two-sided or broad-market strategy. If the holdout shows YES-side edge deterioration relative to the design window, the Stanford finding is the likely explanation — and that deterioration constitutes a structural fail of v2, not a sample-size shortfall. The §13 gates are intentionally stringent in part because of this fragility.

Reference: Stanford 2026 working paper on adverse selection in prediction markets (41.6M Kalshi trades, single-name vs broad-market decomposition); Albers et al. 2025 *Market Maker's Dilemma* (Binance BTC perps live experiment) on the parallel finding that *"bad queue positions are associated with lower fill probabilities and increased adverse selection"* — directly relevant to §10's queue-conservatism choice.

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

Static archive in repo at [`docs/research/kalshi-fee-assumption-kxbtc15m.md`](kalshi-fee-assumption-kxbtc15m.md) (committed `e9d0f28`).

```text
Fee schedule archive:  docs/research/kalshi-fee-assumption-kxbtc15m.md
Static-PDF attachment: pending — see §7 of the archive (operator action;
                       attach kalshi-fee-schedule-2025-07-01.pdf + SHA-256
                       before any canary discussion; not a lock prerequisite
                       under current §13 gate set because the four
                       independent sources are already enumerated in the
                       archive's §2)
```

### 4.2 Taker fee

This v2 policy is maker-only:

```text
taker_exits_allowed = false
taker_fee_applied   = N/A
```

Adding taker exits requires a new preregistration.

## 5. Data windows

### 5.1 Design window

Design data is the **union of two non-contiguous chunks** (NOT a single span). Documenting both endpoints explicitly so the ~9h gap (2026-05-26T13:47Z → 2026-05-26T22:38Z, during which no data was collected) is unambiguously *not* design data — a holdout second falling in that gap remains valid per §5.2's non-overlap rule.

```text
design_data = union_of_chunks {
  chunk_1: 2026-05-25T06:58:04Z → 2026-05-26T13:47:33Z   (30.79h; v1 in-sample)
  chunk_2: 2026-05-26T22:38:33Z → 2026-05-27T09:34:00Z   ( 9.53h; v1 shakeout)
}

design_window_total_observed_hours = 40.32h
design_window_gap_hours            =  8.85h  (between chunk_1 and chunk_2; not design data)
```

Design data may be used for parameter search and hypothesis generation.

### 5.2 Validation holdout window

```text
holdout_window_start_utc = 2026-06-02T00:00:00Z
holdout_window_end_utc   = 2026-06-12T00:00:00Z         # 10-day window
minimum_expected_hours   = 30
distinct_calendar_week   = true
```

**Length rationale (10 days, not 7):** Gate 2 floors are 500 posted / 200 filled / 20 distinct markets. The proposal's estimate of ~100-200 posts per 7-day window assumed the design-window market-opening rate; a 7-day window containing a low-activity weekend or a muted-volatility period could fail Gate 2 for reasons unrelated to strategy quality. 10 days adds operational margin without spanning a fundamentally different market regime.

**Pre-registered single-extension contingency:** if the 10-day holdout fails **only** on sample-size (Gate 2) and **no PnL gate fails**, one extension to 14 days is permitted. This contingency is locked here — it is *not* an option to be invoked after seeing PnL on the original 10-day window. If any PnL gate (3, 4, 5, 6, 7) fails on the 10-day window, no extension is allowed and v2 is rejected.

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
quoting_mode = yes_only_guarded
```

**Rationale (microstructure, not PnL):** the AS scorer's side decomposition (`kalshi-adverse-selection-scorer-2026-05-26.md` table C) shows the YES-bid and NO-bid have *structurally different* microstructure on KXBTC15M — every component except residual flips sign:

```text
component          YES-bid    NO-bid
─────────────────  ─────────  ─────────
spread captured     +0.200¢   −0.776¢
adv selection @60s  +1.012¢   −0.007¢
residual            +0.617¢   +0.389¢
settlement/posted   +0.905¢   −0.218¢
```

Adding a NO leg would add a known structural loser; the inventory-neutrality argument for two-sided is weak at v2's 1-contract / ≤2-directional-cap scale. This is *not* PnL slicing — the component decomposition is microstructure-grounded and consistent with the Stanford 2026 finding that traders systematically overbet YES in single-name Kalshi markets that settle NO (see §2.1).

The §13 Gate 6 one-sided-justification branch is therefore active. The justification is the AS scorer table C decomposition above, *not* aggregate PnL.

### 7.2 Quote side rules

```text
post_yes_bid        = true
post_no_bid         = false
yes_size_contracts  = 1
no_size_contracts   = N/A
disabled_side       = NO
reason              = Structural microstructure asymmetry from
                      kalshi-adverse-selection-scorer-2026-05-26.md table C.
                      NO-bid spread captured −0.776¢ (vs YES +0.200);
                      NO-bid adv@60s −0.007 (vs YES +1.012) — NO leg
                      does not exhibit the mean-reversion recovery that
                      makes YES profitable. Not a PnL-slice rejection.
                      See also §2.1 (Stanford 2026 on YES-overbetting).
```

### 7.3 Quote price

```text
quote_price_rule = at_touch
```

Matches v1 (`at best_yes_bid`). All design-window decomposition (AS scorer + queue model validation) was performed on touch-anchored quotes; moving to `one_tick_behind_touch` would invalidate the per-bucket numbers and effectively require fresh decomposition.

### 7.4 Quote duration / cancellation

```text
quote_duration_seconds          = 75
cancel_on_spread_widen          = true
cancel_on_queue_deterioration   = true
cancel_on_inventory_breach      = true   # required
cancel_before_expiry_seconds    = 60     # don't post in final 1 min of market life
```

**Rationale:** 75s matches the dust executor's existing `KALSHI_DUST_CANDIDATE_TTL_SEC` (validated in the 2026-05-27 dry-run with 20 pending_confirm candidates expiring cleanly at this TTL). The two cancel triggers are direct hedges against the AS scorer's documented 1-30s adverse-selection zone:

- `cancel_on_spread_widen` → book is moving against us; our quote at the old touch is now stale (matches Albers et al. 2025 "stale quote auto-fills" mechanism)
- `cancel_on_queue_deterioration` → our slot is being out-bid or cancels-ahead are skipping us; cancel before we fill at a deteriorated effective position

Stricter "cancel at 1s" was considered but rejected: it would create a higher-churn fill-rate regime than the design-window data was collected under (the AS scorer was on hold-to-TTL quotes), and the per-bucket EV estimates would not transfer cleanly.

Cancellation-aware replay is mandatory. A quote that would have been cancelled by the policy must not receive a ghost fill in the replay.

### 7.5 Time-to-expiry filter

```text
tte_min_seconds = 360    # 6 minutes
tte_max_seconds = 840    # 14 minutes (= 15min market life − 60s cancel-before-expiry from §7.4)
```

**Justification (microstructure-grounded, not PnL-grounded):**

```text
6 min floor: pre-empts the sniper-dominated final-3-min window and the
             structurally-negative 3-6min bucket. AS scorer table B
             shows 3-6min at −0.449¢/posted; 0-3min has n=227 only.
14 min ceiling: matches §7.4 cancel_before_expiry_seconds = 60. The
             policy cannot maintain a 60s cancel-budget for quotes
             posted in the final minute.
Anti-cherry-pick: includes the 9-12min bucket DESPITE its in-sample
             negative EV (−1.002¢/posted). Excluding it would be
             selection on PnL — the exact failure mode this
             preregistration exists to prevent. v1 used the same
             6-15min contiguous logic for the same reason.
```

The literature is consistent that adverse selection intensifies as TTE → 0 (information arrivals become discontinuous near resolution; spread cannot be repriced fast enough). v2 is more conservative as TTE → 0 by both the 6min floor AND the 60s no-post buffer in §7.4.

### 7.6 Time-of-day filter

```text
allowed_utc_hours = [0, 1, 2, 3, 4, 5, 6, 7]    # 00-08Z, the core Asia session
label             = exploratory_origin
```

**Justification (narrower than v1; departs from v1 deliberately):**

```text
8-hour window covering 00-08Z. Microstructure rationale: AS scorer
table G shows 00-04Z at +3.838¢/filled and 04-08Z at +2.574¢/filled —
the two strongest 4h sub-blocks and the only ones with a clean
microstructure story (US institutional flow absent; BTC drifts /
mean-reverts on lower-volume APAC flow).

v1's 12h window [20,24) ∪ [0,8) is NOT inherited. Rationale for
narrowing:

1. v1 failed; continuity with a failed policy is not a virtue.
2. The reviewer memo flagged time-of-day filters first noticed on
   the same 30h tape as overfit-risk. v1's window was first noticed
   on that tape.
3. Velo/CoinDesk May 2026: over the trailing 3 months, APAC hours
   delivered +13% cumulative BTC return, US +11.5%, EU +6.5%. APAC
   is no longer purely a mean-reverting session — it is contributing
   directional gains comparable to US. If the v1 edge depended on
   "BTC mean-reverts overnight," the structural basis for that
   filter has weakened. The narrower 00-08Z window is more defensible
   because its mechanism is "absence of US institutional flow,"
   which is observable (US market hours) rather than inferred
   (overnight mean-reversion regime).
4. Narrowing reduces degrees of freedom, aligning with the
   preregistration's overall conservatism.

The `exploratory_origin` label acknowledges this filter was first
noticed in the design window and cannot be claimed as a first-
principles derivation. If the holdout shows the narrower window
deteriorating, that is the Stanford-finding (§2.1) regime-shift
mechanism, not noise.
```

### 7.7 Spread filter

```text
min_spread_ticks = 1
max_spread_ticks = disabled    # no upper-bound filter
```

**Rationale:** `min_spread_ticks = 1` is a boundary condition (cannot capture half-spread if there is no spread), not a parameter choice. The upper-bound filter is disabled because no specific value is grounded in design-window evidence; the moneyness filter (§7.8) and TTE filter (§7.5) are already correlated with spread and remove the high-spread regime (near-50 markets and final-minute markets) through other mechanisms. Adding an unsupported spread ceiling would be a degree-of-freedom expansion in the wrong direction.

### 7.8 Moneyness filter (binary-contract-specific)

For binary contracts with payoff ∈ {0,1}, "moneyness" is defined as distance of the touch price from `0.50`:

```text
moneyness_metric        = |touch_price - 0.50|
allowed_moneyness_range = [0.15, 0.40]
```

**Rationale:** AS scorer table F:

```text
moneyness bucket       settlement (¢/filled)
─────────────────────  ─────────────────────
near_50 (<0.15)         −0.363    (loses)
lean    (0.15-0.30)     +1.602    (wins)
deep    (≥0.30)         +0.779    (wins)
```

`0.15` lower bound excludes the near-50 noise bucket (mechanism: residual drift only pays off when market has a clear direction to settle toward; structural, not PnL-slice).

`0.40` upper bound is a **drawdown-protection choice, not a profitability-maximization choice.** Touch prices ≤0.10 or ≥0.90 (i.e., `|p−0.5| ≥ 0.40`) have small absolute spreads relative to adverse-move risk: a $0.90 contract moving against us by $0.05 is 5% of contract value on a single fill, which materially pressures the 20% drawdown gate (§13 Gate 4). v1's primary failure mode was drawdown (51% on the shakeout); protecting the drawdown gate takes priority over capturing the deep-bucket's +0.779¢/filled.

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
max_net_yes_contracts          = 2
max_net_no_contracts           = 0          # we don't post NO; no NO exposure should accumulate
max_net_directional_contracts  = 2          # YES-only at size 1 → max net = active YES count
```

Matches the dust executor's existing `KALSHI_DUST_MAX_SAME_SIDE = 2` cap. Codifies the same limit at the preregistration level.

### 9.2 Per-market exposure

```text
max_contracts_per_market      = 1
max_collateral_per_market_usd = 1.00        # = 1 contract × $1.00 max touch price
max_pct_bankroll_per_market   = 10%         # = $2.50 / $25 bankroll (locked)
```

**Structural defense against the v1 failure mode** (one market drove 94.5% of |PnL| in the shakeout). The dust executor's existing `series_in_flight` rejection caps at one quote per *series*; this preregistration tightens to one quote per *market ticker* (multiple markets per series can be live simultaneously, e.g. KXBTC15M-26MAY270545-45 and KXBTC15M-26MAY270600-00 do not collide under series-only logic). Defense in depth alongside §13 Gate 5 (top-1 market ≤ 25% of |PnL|).

### 9.3 Inventory stop

```text
stop_quoting_when_inventory_exceeds_limit = true
resume_when_inventory_back_within_limit   = true
```

## 10. Queue-position model

Kalshi exposes queue position via `GET /portfolio/orders/{order_id}/queue_position`. Per [Kalshi API docs](https://docs.kalshi.com/api-reference/orders/get-order-queue-position) (verified 2026-05-27):

> `queue_position_fp`: "The number of preceding shares before the order in the queue." Queue position is determined using **price-time priority**.

**Operational risk flagged at preregistration time:** the Kalshi documentation does **not** specify how frequently `queue_position_fp` updates, the latency between actual queue changes and the observable field, nor any subscription/streaming mechanism. For live use, queue staleness could materially affect cancellation decisions.

```text
queue_position_freshness_archive = docs/research/kalshi-queue-position-freshness.md
                                   (Phase 1 methodology archived 2026-05-27, commit 617d55a;
                                    Phase 2 empirical measurement deferred — required
                                    before canary only if §10.1 = actual_queue_position_api)
```

### 10.1 Primary queue assumption

```text
primary_queue_model = conservative_threshold
```

**Rationale:**

- The `actual_queue_position_api` path requires Phase 2 empirical freshness measurement, which would require placing a small live dummy order on a separate account (see `kalshi-queue-position-freshness.md` §6) — explicit operator authorization needed. Not lock-now ready.
- `depth_fraction_50` is v1's choice and is documented as under-conservative; the AS scorer queue table (D) shows depth_50 at +0.344¢/posted is the *middle* of the queue-assumption sensitivity range (front +0.526¢, back +0.717¢) — i.e., v1's queue choice was inflating fill rate relative to the back-of-queue stress.
- `conservative_threshold` ties to local-orderbook reconstruction (already validated, see `kalshi-book-reconstructor-validation-2026-05-26.md`) and uses WS-derived queue estimate. Tightens v1's depth_50 toward back-of-queue equivalence.
- Albers et al. 2025: *"bad queue positions are associated with lower fill probabilities and increased adverse selection."* Setting the primary model conservative makes v2 hard to pass — exactly what a preregistration is for. If v2 passes under conservative-threshold, it has a genuine edge.

`actual_queue_position_api` is deferred to v3.

### 10.2 Queue mapping

```text
queue_position_field   = local_reconstructed (NOT queue_position_fp directly)
                          # derived from apps/data-collector/src/replay/queueModel.ts
                          # using WS orderbook deltas + trades; reconstructor validated
                          # at kalshi-book-reconstructor-validation-2026-05-26.md (92.4-94.3%
                          # match to ticker mid; settlement decomposition identity holds
                          # to 1.42e-14¢)

fill_credit_rule       = our quote at price P, size S, is credited as FILLED when:
                         (sum of taker trades at price P after our posting time)
                            >= visible_depth_at_P_at_posting + S
                         AND no cancel event has removed our slot before that point.

                         This is operationally back-of-queue: we assume we join behind
                         ALL existing depth at our price level (queue_position_t0 =
                         visible_depth_t0).

training_data_window   = design_window (§5.1); the reconstructor and queue model
                         have already been validated on these chunks. No coefficients
                         are FIT — the fill_credit_rule is deterministic given the
                         tape, not a learned function.
```

**No empirical fill probability model is used.** This was considered (§10.2 alternative) but rejected: fitting coefficients on design data introduces a degree of freedom that the deterministic conservative-threshold rule does not. **No coefficient may be fit on the validation holdout.**

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

This document incorporates the following refinements over the initial template:

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
| 10 | Stanford 2026 single-name fragility risk added | §2.1 | operator review 2026-05-27 (Stanford working paper, 41.6M Kalshi trades) |
| 11 | ToD filter narrowed from v1's 12h to 00-08Z 8h | §7.6 | operator review 2026-05-27 + Velo/CoinDesk May 2026 (APAC no longer pure mean-reverting) |
| 12 | Holdout extended to 10d with pre-registered 14d sample-size contingency | §5.2 | operator review 2026-05-27 (Gate 2 margin) |
| 13 | Spread filter ceiling disabled (no design-window evidence) | §7.7 | operator review 2026-05-27 |
| 14 | Moneyness upper bound 0.40 = drawdown-protection, not profitability | §7.8 | operator review 2026-05-27 |
| 15 | TTE filter kept contiguous [6,14] min — anti-cherry-pick | §7.5 | operator review 2026-05-27 + v1 anti-cherry-pick precedent |
| 16 | Primary queue model = `conservative_threshold`; API path deferred to v3 | §10.1 | operator review 2026-05-27 (Albers 2025 on conservative queue) |

Reviewer status as of 2026-05-27: *"as rigorous as any academic preregistration I've reviewed for small-scale execution strategies. Green light to proceed — provided you do not inspect the holdout data before locking."*

Operator decisions on the 8 outstanding placeholders are recorded in [`kxbtc15m-v2-parameters-proposal-2026-05-27.md`](kxbtc15m-v2-parameters-proposal-2026-05-27.md) plus the operator review supplement; the decisions are now folded into this document.

## Appendix B — Remaining open items

```text
- Fee schedule PDF static attachment (kalshi-fee-schedule-2025-07-01.<ext>
  + SHA-256) — operator action, NOT a lock prerequisite under current §13
  gate set, but REQUIRED before any canary discussion.

- Queue-position freshness Phase 2 (empirical measurement) — NOT a lock
  prerequisite because §10.1 = conservative_threshold, which does not
  consume the live API. Would become a prerequisite if any future v3 sets
  §10.1 = actual_queue_position_api.

- Holdout collection ≥ 2026-06-02 — execution work; not gated by lock.
  After holdout data exists, the v2 replay scores ONCE against the gates
  in §13. Pass/fail is binary, terminal, and immutable.
```

All §5, §7, §9, §10 placeholders are now filled. §18 (commit record) and §19 (operator sign-off) are filled at lock time only.

---

**End of fill-pass.** Status remains `DRAFT — NOT YET LOCKED`. The next commit transitions Status → LOCKED and fills §18 + §19. No live orders authorized.
