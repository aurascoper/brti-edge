# Pre-registered policy: `BTC_YES_LATE_ASIA_v1` (2026-05-26)

This document is a **pre-registration**. It freezes the policy specification, the in-sample data window from which the policy was derived, the holdout requirements, and the pass gates that apply to fresh data only.

Once this document is committed, the policy is locked. **No filter, threshold, or rule below may be tuned in response to either (a) the in-sample exploratory result or (b) the holdout result.** If the holdout fails, the policy is rejected; a future `v2` would require a new pre-registration on top of a *third* fresh sample.

## Why a pre-registration is needed

The dumb two-sided `BTC_TOUCH_DEPTH50` policy was tested on the 30h dataset captured 2026-05-25T06:58Z → 2026-05-26T13:47Z, and its adverse-selection decomposition (see [[kalshi-adverse-selection-scorer-2026-05-26]]) revealed that:
- the +0.34¢/posted aggregate edge was concentrated in YES-bid (NO-bid was a −0.22¢ drag),
- removing the 6-9min TTE bucket flipped total EV to −0.06¢,
- Asia hours (00-08Z) carried the edge; US hours (08-20Z) were net negative or zero,
- the fill-latency curve was U-shaped, with the 1-30s window adversely selected.

Any policy that *uses these features as filters* and is *tested on the same 30h tape* is overfit by construction. The scorer found the features by looking at the data; testing a feature-filtered policy on that same data is not validation, it's the same fit.

The clean line: pre-register the policy now, validate on fresh data later.

## Policy definition

`BTC_YES_LATE_ASIA_v1` is a single-sided passive maker policy on `KXBTC15M` with explicit TTE and time-of-day filters.

### Inclusion rules (ALL must be true for a hypothetical quote to be posted)

| parameter | value | rationale |
|---|---|---|
| series | `KXBTC15M` | per scorer; ETH was marginal in queue model |
| side | YES-bid only | NO-bid was a drag (−0.22¢/posted) in scorer |
| quote price | at `best_yes_bid` (the touch) | matches the validated touch-anchor regime |
| quote size | **1 contract** | minimum unit; size effects out of scope |
| queue assumption | `depth_fraction_50%` | operationally realistic mid-queue position; front is unrealistic, back is too rare |
| TTE filter | `tte_min ≥ 6` (TTE in 6-9, 9-12, or 12-15 min buckets) | contiguous range covering the two strongest buckets (6-9 + 12-15); 9-12 included to avoid cherry-picking out the trough |
| time-of-day filter | UTC hour in `[20, 24) ∪ [0, 8)` (the 12 hours outside the US daytime block) | scorer showed US daytime hours (08-20Z) were net negative |
| cancel logic | **none — hold to expiry** | simpler than fill-latency-conditional cancel; matches the existing simulator semantics |
| anchor cadence | every 60s during eligible windows | same as passive simulator baseline |

### What this excludes

- The TTE 0-3min and 3-6min buckets (last 6 minutes of market life). Even though 0-3min had positive in-sample EV (+1.13¢/filled), it was small (n=227) and we exclude it to maintain a clean contiguous TTE range.
- The 08-20Z US daytime block.
- All NO-bid quotes.
- All series other than KXBTC15M.
- All cancel-by-latency variations. v1 holds quotes to expiry.

## In-sample data window

`2026-05-25T06:58:04Z` → `2026-05-26T13:47:33Z` (30.79h), captured by `apps/data-collector/` PID 7907.

Authoritative dataset reference: [[kalshi-data-collector-30h-2026-05-26]].

## Exploratory in-sample evaluation

After committing this pre-registration, the policy may be run on the in-sample window for two purposes only:

1. **Implementation sanity check** — confirm the code matches the spec.
2. **Baseline anchoring** — establish the in-sample EV/posted so we can quantify the in-sample-vs-holdout EV decay when fresh data is collected.

The in-sample result is **not validation**. It must be labeled "EXPLORATORY IN-SAMPLE" in every artifact.

## Holdout requirements (the validation step)

### Data collection

- Same `apps/data-collector/` codebase, same schema, same 7 series subscribed (filtered to KXBTC15M at policy run time)
- **Minimum 30h** of capture. **Preferred: 3-7 days** if operator patience allows.
- A different market regime — collected in a calendar week distinct from the in-sample window. Ideally a week with different BTC trajectory (e.g. trending vs ranging, or different vol regime).
- No active worker. No live orders. No interference with the captured tape.
- Capture quality verified by re-running [[kalshi-data-collector-30h-2026-05-26]]'s integrity checks on the new dataset.

### Pass gates (ALL must be true on the holdout)

1. **Positive settlement EV per posted quote** — strictly > 0.
2. **Positive settlement EV per filled quote** — strictly > 0.
3. **Leave-one-TTE-bucket-out survives** — for each of the 3 included TTE buckets (6-9, 9-12, 12-15), the holdout EV/posted with that bucket excluded must remain positive.
4. **Leave-one-time-window-out survives** — for each of the 3 included 4-hour ToD blocks (20-24Z, 00-04Z, 04-08Z), the holdout EV/posted with that block excluded must remain positive.
5. **No single market dominates** — the top-1 market's settlement PnL contribution must be ≤ 25% of total signed PnL.
6. **No single 2-hour wall-clock window dominates** — across the holdout, the top-1 2-hour wall-clock window's signed PnL contribution must be ≤ 40% of total.
7. **YES-side edge remains positive** — trivially true since policy is YES-only, but called out explicitly to prevent the misreading "the policy passed because of an artifact."

If any gate fails, the policy is rejected. There is no "almost passed" carve-out.

### What is explicitly NOT a pass gate

- Statistical significance (t-test p-value). The 30h sample is too noisy for that to be meaningful; even a 7-day holdout may not be. Pass gates are *sign and magnitude consistency*, not significance.
- In-sample-vs-holdout EV ratio. Some in-sample optimism shrinkage is expected and not a fail condition.
- Markout-based EV. Per [[kalshi-passive-policy-btc-touch-depth50-2026-05-26]], markout vs settlement diverge in this venue; settlement is the canonical PnL metric.

## Operator commitment

By committing this document to git, the operator commits to:

- Not modifying the policy's filters, thresholds, or rules between pre-registration and holdout.
- Not selectively reporting holdout results — both pass and fail outcomes will be documented in [[kalshi-passive-policy-btc-yes-late-asia-v1-holdout-{date}]].
- If the policy fails the holdout, no fork or variant will be tested on that same holdout sample (which would be the same overfitting trap on a different dataset).
- No live Kalshi orders until the policy passes a holdout under these gates.

## Implementation

Frozen at `apps/data-collector/src/replay/btcYesLateAsiaV1.ts`. The file's top-of-module comment must reference this pre-registration document by name. Any deviation between the code and this spec is a bug in the code, not a license to amend the spec.

## What's next after this pre-registration commits

1. Run `btcYesLateAsiaV1.ts` once on the in-sample window. Record the EV/posted as the "in-sample baseline" in [[kalshi-policy-preregistration-btc-yes-late-asia-v1-2026-05-26]] (this file).
2. Operator decision: do we collect a fresh 30h-to-7d holdout?
3. If yes, run the data collector again under the same setup. Verify integrity.
4. Run the *unchanged* `btcYesLateAsiaV1.ts` on the fresh holdout. Document the holdout result.
5. Evaluate against the 7 pass gates above. Verdict is binary.

No code refactor, parameter adjustment, or "v1.1" between any of these steps.

## In-sample baseline (recorded 2026-05-26 from exploratory run)

Run command: `pnpm run run-btc-yes-late-asia-v1`. Source code unchanged from the implementation referenced above.

| metric | value |
|---|---:|
| posted | 362 |
| filled | 194 |
| fill rate | 53.6% |
| settlement EV per posted | **+$0.0200** (= +2.00¢) |
| settlement EV per filled | **+$0.0377** (= +3.77¢) |
| total settlement PnL | **+$7.16** |
| usable records (with settlement label) | 358 |

### In-sample gate behavior (recorded — not a validation outcome)

| gate | result |
|---|---|
| 1. EV/posted > 0 | ✓ (+$0.0200) |
| 2. EV/filled > 0 | ✓ (+$0.0377) |
| 3. Leave-one-TTE-out (all three) | ✓ all three remain positive (+$0.008 to +$0.038) |
| 4. Leave-one-ToD-out (all three) | ✓ all three remain positive (+$0.015 to +$0.025) |
| 5. Top-1 market < 25% of \|PnL\| | **✗ 58.7%** — single market `KXBTC15M-26MAY252115-15` contributed the majority |
| 6. Top-1 2h window < 40% of \|PnL\| | ✓ 38.7% (2026-05-25T22Z) — at threshold but passing |
| 7. YES-only edge > 0 | ✓ trivial |

### What the in-sample result tells us

- **The implementation matches the spec.** The filters reduce the sample from ~2,956 (unfiltered) to 362 quotes, all in the pre-registered TTE × ToD cells. This is a sanity check, not validation.
- **The IS EV is positive and the leave-one-out checks all hold within the included buckets.** Gates 1-4 and 6-7 pass in-sample.
- **Gate 5 fails in-sample with a heavy concentration in one 15-minute market.** This is the most informative IS signal: the +$0.020/posted IS edge is driven disproportionately by one event. This does NOT invalidate the policy (we expected the IS result to be optimistic), but it lowers the prior on holdout success — if the holdout also shows extreme single-market concentration, the policy is sensitive to rare events rather than a steady-state edge.
- **Per the operator commitment, none of these results are used to modify the policy.** v1's filters are locked. If the holdout fails any gate, the policy is rejected.

### Expected holdout-vs-in-sample relationship

Standard pre-registration logic: the IS estimate is biased upward by selection. Holdout EV is expected to be smaller than IS EV (sometimes substantially smaller). A holdout EV of e.g. +$0.005-0.015/posted with passing gates would be a strong result. A holdout EV near zero or negative would reject the policy.

The gate 5 IS failure means: if the holdout has the same concentration pattern (one market driving the bulk of PnL), v1 is rejected. If the holdout distributes more evenly across markets, v1 may still pass even at lower headline EV.
