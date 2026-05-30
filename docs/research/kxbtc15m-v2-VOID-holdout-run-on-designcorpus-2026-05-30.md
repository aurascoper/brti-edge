<!-- =================================================================== -->
<!--  VOID RECORD — NOT A HOLDOUT VERDICT — DO NOT CITE AS v2 REJECTION  -->
<!-- =================================================================== -->

# ⛔ VOID holdout run — KXBTC15M_PASSIVE_MAKER_v2 (2026-05-30)

> **THIS IS NOT THE OFFICIAL HOLDOUT. v2 IS NOT REJECTED BY THIS RUN.**
>
> On 2026-05-30, at operator request, a `holdout`-labeled terminal gate run
> was executed against the **MAY 25–27 DESIGN CORPUS** — i.e. the same data
> `btcMakerV2` was built and tuned on, NOT the distinct untouched week that
> the locked preregistration requires (which starts **2026-06-02**).
>
> The run returned **FAIL** (gates 2, 3a, 3b). **That FAIL is VOID** on two
> independent grounds baked into the preregistration:
>
> 1. **Gate 1 (holdout eligibility) is `false` on this corpus.**
>    `pnpm run report -- --since=2026-05-25T00:00:00Z --until=2026-05-27T23:00:00Z`
>    → worst-channel coverage **59.7%** (policy requires ≥99%), worst-channel
>    longest gap **15h** (requires ≤1h), `continuous_holdout_eligible: false`.
>    The harness itself states a score must not be trusted unless Gate 1 = true.
>
> 2. **The Gate 2 failure is a sample-size failure** (posted 109 < 500,
>    filled 21 < 200), which the spec's **§5.2 sample-size extension**
>    exempts from terminal/permanent rejection.
>
> The only signal that survives — negative in-sample EV (−4.57¢/filled,
> adverse selection) — is explicitly NON-citable as edge evidence per the
> harness's own non-holdout guardrail. It is consistent with the
> 2026-05-30 sanity-check smoke; it does not validate or invalidate v2.
>
> **STATUS: v2 remains UNVALIDATED, NOT rejected.** The genuine holdout —
> a `holdout`-labeled run on the sealed, continuity-eligible week from
> 2026-06-02 — is still required and still clean to run.
>
> Cross-refs: `kxbtc15m-v2-preregistration.md` (LOCKED, commit e65a36b),
> `kxbtc15m-v2-implementation-sanity-check-2026-05-27.md`.

---

## Verbatim run output

Command:
```
pnpm exec tsx src/replay/btcMakerV2.ts \
  --log-dir=logs/data-collector \
  --label=holdout-on-designcorpus-NOT-untouched-2026-05-30
# exit code: 1
```


# KXBTC15M_PASSIVE_MAKER_v2 — `holdout-on-designcorpus-NOT-untouched-2026-05-30`

> **HOLDOUT VALIDATION RUN.** §13 Gates 1-9 are computed below.
> Pass/fail is BINARY and TERMINAL. If any gate fails (and the §5.2
> sample-size extension does not apply), v2 is rejected permanently.

- Policy:           KXBTC15M_PASSIVE_MAKER_v2
- Preregistration:  docs/research/kxbtc15m-v2-preregistration.md
- Locked at:        commit A 71216c6, lock e65a36b
- Log dir:          logs/data-collector
- Markets indexed:  164

## Headline

| metric | value |
|---|---:|
| candidate anchors | 1,959 |
| filter rejects | 1,850 |
| posted | **109** |
| filled | **21** |
| fill rate | **19.3%** |
| settlement EV per posted | **$-0.0088** (= -0.881¢) |
| settlement EV per filled | **$-0.0457** (= -4.571¢) |
| total settlement PnL | **$-0.9600** |
| usable records (with settlement label) | 109 |

## Filter rejection breakdown

| reason | count |
|---|---:|
| tte_filter | 811 |
| utc_hour_filter | 654 |
| moneyness_filter | 244 |
| per_market_cap | 86 |
| spread_floor | 55 |

## Cancel-reason breakdown (posted quotes)

| cancel reason | count |
|---|---:|
| spread_widen | 77 |
| none | 21 |
| queue_deterioration | 11 |

## By TTE bucket

| TTE | posted | filled | fill rate | EV/posted ($) | EV/filled ($) |
|---|---:|---:|---:|---:|---:|
| 6-9min | 36 | 4 | 11.1% | $0.0119 | $0.1075 |
| 9-12min | 45 | 13 | 28.9% | $-0.0327 | $-0.1131 |
| 12-15min | 28 | 4 | 14.3% | $0.0029 | $0.0200 |

## By UTC block

| block | posted | filled | fill rate | EV/posted ($) | EV/filled ($) |
|---|---:|---:|---:|---:|---:|
| 00-04Z | 34 | 7 | 20.6% | $-0.0159 | $-0.0771 |
| 04-08Z | 75 | 14 | 18.7% | $-0.0056 | $-0.0300 |

## Concentration metrics (NOT gates on non-holdout runs)

| metric | value | reference §13 threshold |
|---|---|---|
| top-1 market |PnL| share | **14.3%** (KXBTC15M-26MAY252215-15) | Gate 5: ≤ 25% |
| top-1 2h-block |PnL| share | **15.6%** (2026-05-26T06) | Gate 5: ≤ 40% |
| top-1 hour-of-day |PnL| share | **17.2%** (UTC 0) | Gate 5: ≤ 40% |
| distinct markets w/ ≥1 fill | 21 | Gate 2: ≥ 20 |

**Holdout run: §13 Gate logic follows.**

## §13 Pass gates (HOLDOUT)

Gate 1 (holdout eligibility) is checked externally via `pnpm run report`; rerun and confirm continuous_holdout_eligible=true before trusting this score.

Gate 2 (sample size: posted ≥ 500, filled ≥ 200, distinct ≥ 20): posted=109, filled=21, distinct=21 → ✗
Gate 3a (EV/posted > 0): $-0.0088 → ✗
Gate 3b (EV/filled > 0.01): $-0.0457 → ✗
Gate 4 (drawdown ≤ $5 / 20%) is computed by btcMakerV2Capped.ts; confirm in the capped report.
Gate 5a (top-1 market ≤ 25%): 14.3% → ✓
Gate 5b (top-1 2h ≤ 40%): 15.6% → ✓
Gate 5c (top-1 hour ≤ 40%): 17.2% → ✓
Gate 6 (one-sided branch active per §7.1 yes_only_guarded): structural justification is the AS scorer table C decomposition; max_net_directional ≤ 2 enforced at post time. ✓ (provided AD-3 was honored — confirm in the cancel-reason and reject breakdowns above).
Gate 7 (queue robustness): rerun with --queue=front and --queue=back to populate the three-scenario report. This single run was primary (conservative_threshold).
Gate 8 (no ghost fills): 0 → ✓
Gate 9 (no post-hoc tuning): verify externally that the running commit hash matches preregistration_commit (71216c6) at scoring time. This check cannot be self-attested.

**HOLDOUT GATES IN THIS REPORT: FAIL** (3 of the in-this-report gates failed):
- Gate 2 sample size
- Gate 3a EV/posted
- Gate 3b EV/filled
