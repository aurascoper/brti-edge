# Kalshi fee assumption — `KXBTC15M`

**Status:** static archive (sourced from external Kalshi fee documentation)
**Created:** 2026-05-27
**Verifies:** §4.1 of `kxbtc15m-v2-preregistration.md`
**Decision recorded:** maker fee on `KXBTC15M` = **$0** (zero), no per-trade rebate, no institutional subsidy assumed.

This document exists so the fee claim in the v2 preregistration is sourced from a *repo file* and not only from operator memory. The v2 preregistration cannot be locked without this archive present (per Appendix B of that document).

---

## 1. Decision

```text
maker_fee_rate_kxbtc15m = 0.00       # $0 per contract, both YES and NO sides
taker_fee_rate_kxbtc15m = variable   # 0.07%–7% sliding by contract price; NOT used in v2
settlement_fee          = 0.00
institutional_rebate    = NOT ASSUMED
volume_incentive_rebate = NOT ASSUMED
major_event_flat_fee    = NOT APPLICABLE (only NFL/NBA/elections series)
```

For v2's purposes, makers on `KXBTC15M` pay **zero** to place, hold, and have filled a passive limit order. Cancellation is also free.

## 2. Source documents

This decision was verified against four independent sources on **2026-05-25** (see claude-mind memory `kalshi-ou-characterization-2026-05-25`, entry id `5166358F-FC3B-4766-8192-7E22C4EE5AF8`, tag `fee-schedule-correction`):

| # | Source | Used for |
|---|---|---|
| 1 | Kalshi fee schedule PDF (effective 2025-07-01) | primary fee table per series-class |
| 2 | Kalshi help center fee FAQ | confirmation of $0 maker on standard markets |
| 3 | `laikalabs.com` exchange-comparison table | independent third-party tabulation |
| 4 | CFTC filing references (Kalshi DCM filings) | regulatory disclosure of fee structure |

All four agree that the standard `KX*15M` crypto markets (which include `KXBTC15M`, `KXETH15M`, `KXSOL15M`, `KXBNB15M`, `KXDOGE15M`, `KXXRP15M`, `KXHYPE15M`, `KXBCH15M`, `KXADA15M`) carry a **$0 maker fee** with **no automatic per-trade rebate** at the retail tier.

**Pre-lock requirement:** before flipping the v2 preregistration to `Status: LOCKED`, the operator must attach a static copy (or screenshot, or transcribed text) of the Kalshi fee schedule PDF effective 2025-07-01 alongside this file, named `kalshi-fee-schedule-2025-07-01.<ext>`. The PDF SHA-256 must be recorded below:

```text
kalshi-fee-schedule-2025-07-01.pdf  SHA-256 = <fill at archive time>
```

This is an evidentiary lock — once the v2 preregistration is locked, the fee assumption is frozen to whatever is captured in that specific archived file. If Kalshi changes the schedule afterward, v2 retains the locked assumption (and any future v3 would need a fresh archive).

## 3. What "0% maker" supersedes

This decision **supersedes** an earlier "up to 1% maker rebate" framing that appeared in the 2026-05-25 Path D maker-execution memo. That number came from a Sacra (private-market research) post that conflated two distinct programs:

### 3.1 Institutional Market Maker Agreement — NOT APPLICABLE

```text
Program:        Kalshi Institutional Market Maker Agreement (separate program)
Rebate:         up to 1% tiered, capped at $7,000/week
Eligibility:    requires an executed Market Maker Agreement with Kalshi
Retail access:  NO — not available to retail or sub-institutional accounts
Applies to v2:  NO — v2 operates at $25 bankroll, not institutional scale
```

The 1% rebate exists, but it is gated by a signed agreement Kalshi negotiates with designated institutional liquidity providers. A retail account placing passive orders does **not** receive it.

### 3.2 Volume Incentive Program — NOT ASSUMED

```text
Program:        Volume rebate on accrued taker fees
Rebate:         60% on $750-$2000 of accrued fees, 80% above
Applies to:     taker side only — rebates a fraction of *paid* taker fees
Applies to v2:  NO — v2 is maker-only (taker_exits_allowed = false in §4.2)
```

Even if v2 ever switched to allow taker exits, the volume tiers ($750+ in accrued fees) are unreachable at a $25 bankroll.

### 3.3 Major Event Flat Maker Fee — NOT APPLICABLE

```text
Markets:        NFL, NBA, elections, certain sports
Maker fee:      0.25% flat
Applies to:     designated "major event" series only
Applies to v2:  NO — KXBTC15M is a standard crypto market, not a major-event series
```

The 0.25% flat fee on major-event markets is the **only** non-zero retail maker fee Kalshi charges. It does **not** apply to crypto 15M binaries.

## 4. Taker fee (informational; not used by v2)

Recorded for completeness. v2 does not exit via taker, so the taker fee never enters v2's PnL accounting. However, the value is relevant for any future v3+ that contemplates taker exits or for sizing the "what if we crossed the spread" counterfactual.

```text
taker_fee_kxbtc15m(price_dollars) ≈ contract_value × ratio
  where ratio slides from ~0.07% near $0 or $1
  to a peak of ~1.5625¢/contract at $0.50
```

Practical implication: at a $1 notional with the touch price near $0.50, crossing the spread costs roughly 1.5¢ in fees alone — almost double the maker's captured ½-spread. Taker exits are structurally negative on these contracts.

## 5. EV budget implications (sourced from same memory entry)

With maker fee = $0 confirmed, the maker EV decomposition simplifies to:

```text
maker_ev_per_filled_quote
  = (1/2 × spread_captured_at_fill)
  − adverse_selection_cost
  − exit_taker_cost                 # 0 for v2 hold-to-settlement
  − maker_fee                       # 0 for KXBTC15M
```

For v2 (hold-to-settlement, maker-only):

```text
budget_for_adverse_selection ≤ 0.5¢/filled
  (entry ½-spread captured, no exit cost,
   full AS realizes at settlement)
```

This is the binding constraint that the holdout will test. If the empirical AS cost on the holdout exceeds the ~0.5¢ captured spread, v2 cannot have positive EV — there is no fee subsidy to fall back on.

## 6. What changes if Kalshi changes the schedule

If Kalshi publishes a new fee schedule after this archive is committed:

```text
- The locked v2 preregistration retains the assumption as-archived.
- A new v3+ preregistration may use the updated schedule, with a new
  fee-assumption archive file.
- The dated archive (`kalshi-fee-schedule-2025-07-01.<ext>`) MUST NOT be
  edited or deleted; it is the evidentiary record for v2's results.
- Any holdout scoring done under v2 remains interpreted against the
  archived assumption, not the current one.
```

This matches the "policy, not tunable" principle in `CLAUDE.md` §Conventions: the gate constants and assumptions captured at lock time are interpretive anchors; changing them retroactively destroys the meaning of prior pass/fail decisions.

## 7. Pre-lock checklist

Before the v2 preregistration may be locked:

```text
[x] Maker fee decision recorded (this file, §1)
[x] Source documents enumerated (§2)
[ ] kalshi-fee-schedule-2025-07-01.<ext> attached alongside this file
[ ] SHA-256 of the attached archive filled into §2
```

The two unchecked items are operator action; this template does not perform them.

---

**Companion documents:** `kxbtc15m-v2-preregistration.md` (§4.1, §13 Gate 3 EV calculations), `CLAUDE.md` §Conventions.
