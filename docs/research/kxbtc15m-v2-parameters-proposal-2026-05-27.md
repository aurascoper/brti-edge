# v2 parameter proposal (DRAFT — for operator review only)

**Status:** proposal, not yet incorporated into preregistration
**Created:** 2026-05-27
**Target:** fill `<fill>` placeholders in `kxbtc15m-v2-preregistration.md` §5, §7, §9, §10
**Discipline:** every proposed value is grounded in design-window evidence (v1 in-sample 30h + 9h shakeout + AS scorer + queue model validation). No holdout-window data inspected.

For each placeholder I propose: **value + microstructure-grounded rationale + how it relates to v1**. Operator reviews each line; nothing flows back to the preregistration until approval.

---

## §5.1 Design window

```text
PROPOSED:
design_window_start_utc = 2026-05-25T06:58:04Z
design_window_end_utc   = 2026-05-27T09:34:00Z
```

**Rationale:** Spans the v1 30h in-sample capture (06:58Z 2026-05-25 → 13:47Z 2026-05-26 per the existing 30h doc) **plus** the 9h shakeout prerun (22:38Z 2026-05-26 → 09:34Z 2026-05-27). The ~9h gap in the middle (2026-05-26T13:47Z → 22:38Z) is *not* design data — but its presence means the design window is non-contiguous. Documenting both endpoints captures the full window-of-reasoning.

**Variant the operator might prefer:** treat design data as the *union* of two non-contiguous chunks, listed explicitly:

```text
design_data = {
  chunk_1: 2026-05-25T06:58:04Z → 2026-05-26T13:47:33Z (30.79h, v1 in-sample),
  chunk_2: 2026-05-26T22:38:33Z → 2026-05-27T09:34:00Z (9.53h, v1 shakeout)
}
```

This avoids the implication that anything in the gap is design data.

---

## §5.2 Holdout window

```text
PROPOSED:
holdout_window_start_utc = 2026-06-02T00:00:00Z   # earliest allowed per existing rule
holdout_window_end_utc   = 2026-06-09T00:00:00Z   # 7d window, "preferred" per v1 preregistration
```

**Rationale:** v1's pre-registration already specified ≥ 30h, preferred 3-7 days, distinct calendar week. 7-day window:
- Provides the ≥ 500 posted / ≥ 200 filled / ≥ 20 distinct markets the v2 §13 Gate 2 requires
- Spans multiple weekday/weekend BTC regimes for the time-of-day filter
- 7 days × 12 eligible hours × 4 markets/hour ≈ 336 candidate anchors before filters; after TTE/spread/moneyness filtering, ≈ 100-200 posts feasibly fillable. The Gate 2 floors are tight against this — extending to 10-14 days if needed for sample size is a defensible alternative.

**Variant:** if 7d is too short to hit ≥200 fills, extend to 10-14d. Should NOT be picked based on what gives a better PnL — but is a legitimate concern about sample size.

---

## §7.1 Quoting mode

```text
PROPOSED:
quoting_mode = yes_only_guarded
```

**Rationale (microstructure, not PnL):** the AS scorer's side decomposition (table C, `kalshi-adverse-selection-scorer-2026-05-26.md` line 64-65) shows the YES-bid and NO-bid have structurally different microstructure on KXBTC15M:

| component | YES-bid | NO-bid |
|---|---:|---:|
| spread captured | +0.200 | **−0.776** |
| adv selection @ 60s | +1.012 | −0.007 |
| residual | +0.617 | +0.389 |
| settlement (¢/posted) | **+0.905** | **−0.218** |

Every component except residual flips sign. This is a *side asymmetry*, not a PnL slice. Likely mechanism: KXBTC15M strikes are set near current BTC, and informed flow over the 30h sample was net-asymmetric (informed NO-sellers crossing to lift YES bids more aggressively than the converse). Whatever the cause, the asymmetry is *structural*, not just sample-PnL-driven.

**Two-sided with NO-side guards** (the reviewer memo's recommended default) was considered. Reasons to reject for v2:
- The NO-side −0.22¢/posted with adv@60s = −0.007 (no mean-reversion) means the NO leg leaks even before residual drift. The reviewer's strict `no_side_ev_per_posted >= 0` gate would almost certainly fail. The relaxed alternative `> -0.002 AND total > 0` could pass but would still mean the NO leg is a structural drag the YES leg subsidizes — not "necessary for inventory neutrality" so much as "subsidized loss."
- Inventory neutrality is the typical reason for two-sided quoting; v2 doesn't run continuous inventory at this scale (1 contract per quote, ≤2 net directional cap). The inventory case is weaker than for size-quoting.
- v1's failure mode was concentration, not directional exposure. Two-sided wouldn't have fixed v1; it would have made it lose money on both sides.

**Operator decision required:** confirm `yes_only_guarded` (matches v1 side choice but with the §13 Gate 6 one-sided-justification gate active). Alternative: `two_sided_inventory_guarded` with the relaxed Gate 6 formulation `> -0.002 AND total > 0`.

---

## §7.2 Quote side rules

```text
PROPOSED (given §7.1 = yes_only_guarded):
post_yes_bid       = true
post_no_bid        = false
yes_size_contracts = 1
no_size_contracts  = N/A
disabled_side      = NO
reason             = Structural microstructure asymmetry from
                     kalshi-adverse-selection-scorer-2026-05-26.md table C.
                     NO-bid spread-captured is −0.776¢ (vs YES +0.200);
                     NO-bid adv@60s is −0.007 (vs YES +1.012). NO leg
                     does not exhibit the mean-reversion recovery that
                     makes YES profitable. Not a PnL-slice rejection.
```

**Rationale:** size = 1 matches v1 and the dust executor's existing `KALSHI_DUST_MIN_ORDER_SIZE`. Size effects are out of scope for v2 (would require their own decomposition).

---

## §7.3 Quote price

```text
PROPOSED:
quote_price_rule = at_touch
```

**Rationale:** matches v1 (`at best_yes_bid`). All design-window decomposition was performed on touch-anchored quotes (`BTC_TOUCH_DEPTH50` policy). Moving to `one_tick_behind_touch` would invalidate every per-bucket number in the AS scorer — a parameter choice that effectively requires a fresh decomposition.

**Alternative** `only_when_spread_ge_N_ticks` could be considered as a noise filter, but spread-filter logic is already in §7.7 and shouldn't double-up here.

---

## §7.4 Quote duration / cancellation

```text
PROPOSED:
quote_duration_seconds        = 75
cancel_on_spread_widen        = true
cancel_on_queue_deterioration = true
cancel_on_inventory_breach    = true   # required
cancel_before_expiry_seconds  = 60     # don't post in final 1 min of market life
```

**Rationale:**

- **75s** matches `KALSHI_DUST_CANDIDATE_TTL_SEC` in §10 of README (existing config, already validated in dry-run). The 30-min Kalshi dry-run today saw 20 pending_confirm candidates expire cleanly at this TTL.
- **`cancel_on_spread_widen`** is new in v2. Microstructure rationale: the AS scorer fill-latency table (line 86-92) shows the 1-30s window is adversely selected. If the spread widens after we post, the book is moving — that's exactly when the 1-30s adverse-selection regime kicks in. Cancel and re-post (or step aside).
- **`cancel_on_queue_deterioration`** is the queue-position-API consumer. If `queue_position_fp` moves *worse* (more shares ahead of us) between polls, our slot is being out-bid or has been bypassed by cancels-ahead; cancel rather than wait.
- **`cancel_before_expiry_seconds = 60`** — the 0-3min and 3-6min TTE buckets had mixed/negative behavior (table B). Sniping risk is concentrated in the final minute. Stopping posting at 60s-to-expiry is a strict cut.

**Note on the fill-latency "cancel 1-30s or hold past 30s" prescription:** the AS scorer flagged a 1-30s adverse-selection zone (lines 84-96). The cleanest implementation would be "cancel any quote not filled within 1s, else hold to TTL." But that's an aggressive cancel rate and could lead to high quote churn. v2's `quote_duration_seconds = 75` with `cancel_on_spread_widen` + `cancel_on_queue_deterioration` is a softer version of the same intuition — cancel when the market shows you're now in the danger zone, not on a fixed timer.

**Operator decision required:** confirm 75s, or pick the stricter "cancel-at-1s" variant. The stricter variant has stronger microstructure justification but creates higher operational load and a different fill-rate regime than the design-window data was collected under.

---

## §7.5 TTE filter

```text
PROPOSED:
tte_min_seconds = 360    # 6 minutes
tte_max_seconds = 840    # 14 minutes (excludes final 1 min — matches §7.4 cancel_before_expiry)
```

**Rationale:**

- **`tte_min = 360s`** matches v1's `6 min`. The 0-3min and 3-6min buckets are excluded for the same reasons v1 excluded them: 0-3min has small n=227 and is sniper territory; 3-6min is structurally negative (−0.449¢/posted in design-window).
- **`tte_max = 840s`** is slightly tighter than v1's implicit `15 min` (whole market life). The cut to 14 min reflects the §7.4 `cancel_before_expiry_seconds = 60` rule — we don't *post* in the final minute, so the effective max TTE is 14 min.

**Honest microstructure note:** the 9-12min bucket is a loser (−1.002¢/posted) in design data. The "right" filter from a maximum-PnL standpoint would exclude it (use 6-9 ∪ 12-15 non-contiguously). v1 deliberately included 9-12 to avoid cherry-picking; v2 should do the same. The reviewer memo emphasized "if 'late Asia' emerged from exploratory PnL slicing, it's suspect" — that logic applies equally to TTE buckets. Keeping 6-14min contiguous is anti-cherry-pick.

**Justification field for §7.5:**
```text
6 min floor: pre-empts the sniper-dominated final-3-min window and
             the structurally-negative 3-6min bucket (per AS scorer
             table B). v1 used the same floor for the same reason.
14 min ceiling: matches the cancel-before-expiry policy in §7.4;
             prevents posting in TTE bands the policy cannot maintain
             a cancel-budget for.
Anti-cherry-pick: includes the 9-12min bucket despite its in-sample
             negative EV. Excluding it would be exactly the
             selection-on-PnL the preregistration exists to prevent.
```

---

## §7.6 Time-of-day filter

```text
PROPOSED:
allowed_utc_hours = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7]   # = v1's [20,24) ∪ [0,8)
```

**Rationale:** matches v1 exactly. AS scorer table G (line 110-119) shows:
- 00-04Z Asia: +3.838¢/filled
- 04-08Z: +2.574¢/filled
- 20-24Z: +1.251¢/filled
- 08-20Z: net negative or zero

The 12-hour late-Asia + early-Europe + late-US-evening window has positive per-filled EV in every 4h sub-block. This is *not* cherry-picking out of US hours on PnL grounds alone — the microstructure interpretation is "BTC mean-reverts overnight when US flow is absent; BTC trends during US session and informed taker flow dominates." That's a structural mechanism, not a PnL-slice.

**Justification field for §7.6:**
```text
12 hours covering 20-24Z + 00-08Z. Microstructure rationale: AS scorer
table G shows mean-reverting drift behavior dominates during low-US-flow
hours; during US session (08-20Z), informed-taker dominance flips the
sign of adverse selection. Same window as v1; same justification.
This is exploratory_origin (the v1 preregistration first noticed this
on the same 30h tape), but the structural mechanism is consistent
across hours within the window.
```

**Operator decision required:** the reviewer memo flagged that "if the time-of-day filter was selected from design-window PnL slicing alone, it must be treated as overfit-risk." v2 inherits the v1 window for continuity, but the operator could legitimately argue for a NARROWER window (e.g., just 00-08Z = the strongest 8 hours, label `exploratory_only`) or a BROADER window (e.g., 16-24Z + 00-08Z = the +1.25¢/filled 20-24Z block extended backward). Holding to v1's exact window is the most conservative continuity choice.

---

## §7.7 Spread filter

```text
PROPOSED:
min_spread_ticks = 1     # at least 1 cent of spread; never quote on a 0-spread book
max_spread_ticks = 8     # if spread > 8 cents, market is too disorderly to maker-quote
```

**Rationale:** v1 didn't have an explicit spread filter — it took whatever spread was present at the touch. The AS scorer didn't decompose by spread (only by moneyness, which is correlated). Adding this in v2 is a new filter, so it carries overfit risk.

- **`min_spread_ticks = 1`** is a sanity floor — you can't capture half-spread if there is no spread. Operationally this matches the existing `KALSHI_DEF_SPREAD_MIN` notion in `polyterminal/.env.example`.
- **`max_spread_ticks = 8`** is a noise filter. A KXBTC15M book with 8+ ticks of spread is either thin or has a no-arb violation about to resolve. Either way, posting maker quotes into that regime is high-risk.

**Honest assessment:** I don't have design-window evidence supporting the specific value 8. It's an operational sanity bound, not a microstructure finding. The operator should pick a value they can justify (or set the filter to `disabled` and let the moneyness + TTE filters do the work).

**Variant:** disable the spread filter entirely (`min_spread_ticks = 0, max_spread_ticks = Infinity`). Defensible — it's one fewer degree of freedom.

---

## §7.8 Moneyness filter

```text
PROPOSED:
moneyness_metric        = |touch_price - 0.50|
allowed_moneyness_range = [0.15, 0.40]
```

**Rationale:** AS scorer table F (line 102-104):

| moneyness | settlement (¢/filled) |
|---|---:|
| near_50 (<0.15) | **−0.363** |
| lean (0.15–0.30) | +1.602 |
| deep (≥0.30) | +0.779 |

Near-50 markets (≈ pure noise, 50/50 binary at posting time) consistently lose: residual drift to settlement is *negative* (table F: −0.660¢). The lean + deep buckets win. Excluding near-50 is a structural cut, not a PnL slice — the mechanism (residual drift only pays off when the market has a clear direction to settle toward) is microstructure-grounded.

**Range `[0.15, 0.40]`:**
- `0.15` lower bound = exclude near-50 noise markets (the AS scorer cut)
- `0.40` upper bound = exclude deep-in-the-money where touch price is < 0.10 or > 0.90. At those extremes, the half-spread capture (~0.5¢) approaches 5-10% of the contract value; one bad fill can move drawdown materially in % terms.

**Operator decision required:** the upper bound is judgment, not data. The deep bucket in table F (≥0.30) won at +0.779¢/filled — including it. The cleaner alternative is `[0.15, 0.49]` (anything not-noisy is fair game). Note: the moneyness bucket boundaries don't perfectly align with `|p-0.5|` (deep ≥0.30 = touch ≤0.20 or ≥0.80), so a precise mapping would need re-decomposition.

---

## §9.1 Net directional exposure

```text
PROPOSED:
max_net_yes_contracts          = 2
max_net_no_contracts           = 0       # we don't post NO; no exposure should accumulate
max_net_directional_contracts  = 2       # YES-only at size 1 means max net = active position count
```

**Rationale:** v2 is YES-only with size=1; the dust executor's `KALSHI_DUST_MAX_SAME_SIDE` = 2 already caps active YES quotes. This codifies the same limit at the preregistration level. The reviewer memo's "max net directional ±2" maps to "2 active YES quotes max."

---

## §9.2 Per-market exposure

```text
PROPOSED:
max_contracts_per_market      = 1
max_collateral_per_market_usd = 1.00     # 1 contract × $1 max price
max_pct_bankroll_per_market   = 10%       # already locked in template; consistent with above
```

**Rationale:** the dust executor's `series_in_flight` rejection already enforces one active quote per series at a time. Per-market is even tighter (one *market ticker*, not one *series* — multiple markets per series can be live simultaneously, e.g. KXBTC15M-26MAY270545-45 and KXBTC15M-26MAY270600-00). `max_contracts_per_market = 1` is the structural cap that prevents the v1 failure mode where one market drove 94.5% of PnL.

**Operator note:** combined with the §13 Gate 5 "top-1 market ≤ 25%" gate, this provides defense-in-depth. The Gate 5 holdout check catches a single market dominating *concentrated* PnL even if exposure per market was capped at 1 contract. Both are needed.

---

## §10.1 Primary queue assumption

```text
PROPOSED:
primary_queue_model = conservative_threshold
```

**Rationale:** the queue-position-freshness measurement is Phase 1 only (methodology, no empirical numbers). v2 lock can proceed *without* live queue reads if `primary_queue_model` is set to a path that doesn't require them. `conservative_threshold` is that path:
- Uses local order-book reconstruction (already validated, see `kalshi-book-reconstructor-validation-2026-05-26.md`)
- Estimates queue position from WS deltas (depth at quote price + own posting time)
- Fills credited when cumulative trades at our price level cover both the preceding depth AND our own size

This is what the existing `queueModel.ts` already implements at `depth_fraction_50%`. Tightening to `conservative_threshold` (e.g., depth_fraction_25%, mid-queue toward back) reduces fill rate but tightens the queue assumption against adverse selection.

**Alternative**: `actual_queue_position_api`. This becomes available only after Phase 2 of the freshness measurement passes. If the operator wants v2 to use the live API, lock can be deferred until Phase 2 is complete. The reviewer memo's preferred path was "actual_queue_position_api where available; otherwise conservative_threshold" — the *current* state is "not available yet," so `conservative_threshold` is the lock-now choice.

---

## §10.2 Queue mapping

```text
PROPOSED (given §10.1 = conservative_threshold):
queue_position_field = (derived from order-book reconstructor; not queue_position_fp directly)
fill_credit_rule     = our quote at price P, size S, is credited as filled when:
                       (cumulative trades at price P after our posting time) >= (depth_at_P_at_posting) + S
                       AND no cancel event has removed our slot
training_data_window = same as design_window (§5.1); the reconstructor was validated on
                       the v1 30h capture and the 9h shakeout was within its operational bounds
```

**Rationale:** matches `apps/data-collector/src/replay/queueModel.ts` semantics exactly. The conservative-threshold formulation is equivalent to the existing `back_of_queue` queue assumption in the codebase. The v1 in-sample used `depth_fraction_50%` (more permissive); v2 tightens to back-of-queue for the *primary* scenario and reports the more-permissive `depth_fraction_50%` as a stress.

**Alternative formulation** if operator prefers depth_fraction_50% as primary (matching v1 directly):

```text
primary_queue_model = depth_fraction_50
fill_credit_rule    = our quote at price P, size S, is credited as filled when:
                      (cumulative trades at P after our posting time) >= (0.5 × depth_at_P_at_posting) + S
```

This keeps continuity with v1's in-sample but exposes v2 to the same queue-naivety risk. The reviewer memo strongly preferred a more-conservative primary.

---

## §13 Gate 6 (NO-side decomposition) formulation

The template offers two locked formulations:

```text
DEFAULT:     no_side_ev_per_posted >= 0
ALTERNATIVE: no_side_ev_per_posted > -0.002 AND total_ev_per_posted > 0
```

**Given §7.1 = yes_only_guarded, this gate is N/A** — v2 doesn't post NO bids, so the NO-side EV is undefined. The applicable branch is the one-sided variant:

```text
ACTIVE (one-sided):
  directional_exposure_justification_present     = true
    (justification = the AS scorer table C side asymmetry, per §7.2 above)
  max_net_directional_contracts_gate_passed      = true
    (≤ 2 per §9.1)
```

**Operator decision required:** if §7.1 flips to `two_sided_inventory_guarded`, the gate choice between DEFAULT and ALTERNATIVE becomes load-bearing. Recommend ALTERNATIVE (`> -0.002 AND total > 0`) only if the operator believes the inventory-neutrality benefit of two-sided outweighs the small NO leak.

---

## §10.3 Catastrophic threshold (operator confirmed)

```text
CONFIRMED:
catastrophic_back_of_queue.ev_per_posted_threshold = -0.01    # per operator decision 2026-05-27
```

No change to the template; this just records that the threshold is locked at −1¢/posted per the reviewer memo and operator confirmation.

---

## What's NOT in this proposal (operator must decide)

- **§4.1 Fee archive (PDF SHA-256):** requires the operator to attach the 2025-07-01 fee schedule PDF.
- **§10 Queue-freshness archive path:** Phase 1 doc now exists at `kalshi-queue-position-freshness.md`; the `<fill>` is just the path reference.
- **§18 Commit hashes:** filled at lock time.
- **§19 Operator sign-off:** operator action at lock time.

---

## Summary of operator decisions required before flip-to-LOCKED

```text
[ ] §5.1: contiguous window vs union-of-chunks framing
[ ] §5.2: 7d holdout vs 10-14d for sample size
[ ] §7.1: yes_only_guarded (proposed) vs two_sided_inventory_guarded
[ ] §7.4: 75s TTL with cancel triggers (proposed) vs strict 1s cancel
[ ] §7.6: v1's 12h window (proposed) vs narrower vs broader
[ ] §7.7: spread filter [1, 8] ticks (proposed) vs disabled
[ ] §7.8: moneyness [0.15, 0.40] (proposed) vs [0.15, 0.49] broader
[ ] §10.1: conservative_threshold (proposed, lock-now) vs actual_queue_position_api (waits for Phase 2)
```

Once these are settled, edit the preregistration in a single commit that fills all `<fill>` fields and changes nothing else, then immediately follow with the LOCK commit (Status → LOCKED, commit hashes, operator sign-off). Two-commit sequence keeps the lock atomic.
