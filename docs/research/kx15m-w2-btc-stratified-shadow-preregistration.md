# Pre-registration: `KX15M_FV_TAKER_BTC_W2` — BTC-primary stratified shadow test

**Status:** **LOCKED** (see §13 for lock provenance; §12 logs every post-peek amendment with direction)
**Created:** 2026-08-02
**Locked:** 2026-08-03 (lock commit hash in §13; W2 starts at the first UTC hour boundary after it)
**Frozen:** No parameter, threshold, gate, fill rule, fee constant, window bound, or scoring-code path may change from the lock commit until the §8 battery has been evaluated at window close (or §8a early-GO). The scoring path re-freezes at the lock commit.
**Policy under test:** the fair-value taker scanner exactly as frozen — `fairValueArbStrike` decisions logged by `src/kalshi/worker.ts` at tag `stage-a-holdout-20260801` (+ the post-W1 `brier_bakeoff.py` n=0 patch; final scoring-code tag recorded at lock, §9)
**Repository:** `aurascoper/brti-edge`
**Author/operator:** `aurascoper`
**Relationship to prior preregistrations:** `KXBTC15M_PASSIVE_MAKER_v2` (2026-05-27) remains LOCKED on its own execution-side track and is neither reopened nor superseded. This document governs only the shadow taker policy already running under launchd. The R7 live-trading closure stands: **this document does not authorize any live Kalshi orders.** Stage B (§11) is a pre-commitment that unlocks only on a full §8 GO.

---

## 1. Purpose

Test, on unseen forward data, whether the shadow scanner's fair-value taker signal has positive settlement EV net of fees **on KXBTC15M specifically**, under the hypothesis that its apparent edge concentrates where book depth and reference-feed fidelity are highest.

```text
Design data    = everything through the lock commit: R1–R6 (285 fills),
                 the W1 30h holdout (2026-08-02T04:16:47Z → 08-03T10:16:47Z),
                 all interim peeks (19h preliminary: BTC +7.04¢/ct, n=76),
                 and W1's official Stage A output.
Validation     = W2, scored ONCE against §8. No second look, no re-slicing.
```

## 2. Origin of the hypothesis — stated plainly

The BTC cell was noticed in a 19-hour interim peek at W1 (best of seven series, selected after looking). That observation has **zero evidential standing** — it is contaminated by multiple comparisons and is exactly the shape of R3's luck (Fisher p = 0.37). This prereg exists to convert it into a falsifiable forward claim. The mechanistic justification (why BTC *ex ante*, not merely "it ranked first"):

- deepest order book of the nine series → smallest stale-quote/phantom-edge component in measured "edge";
- highest-volume underlying → the BRTI-style composite (Coinbase+Kraken+Bitstamp) and σ estimate are least noisy for BTC;
- BRTI is settlement-authoritative (89.4% match, binomial p = 1.27e-30) and BTC is its native asset.

The symmetric prediction that makes this falsifiable in both directions: thin-book series should show *no* durable edge (their W1 nominal edges being quote artifacts). W2 reports both.

## 3. Stratification (answers the design question)

| Stratum | Series | Role in W2 |
|---|---|---|
| **S1 — primary** | KXBTC15M | The ONLY promotable stratum. §8 gates apply here. |
| **S2 — secondary** | KXETH15M, KXSOL15M | Scored and reported with CIs. **Not promotable** this window regardless of result; a passing look earns them their own W3 prereg. |
| **S3 — tertiary** | KXBNB15M, KXXRP15M, KXDOGE15M, KXHYPE15M (+ KXADA15M, KXBCH15M if listed) | Logged only (shadow logging continues for all nine — data is free and feeds later hypotheses). Reported descriptively. |

Rationale: one primary endpoint avoids multiplicity correction entirely; "dropping" XRP/DOGE/BNB from *promotion* costs nothing while dropping them from *logging* would destroy the falsification test in §2.

## 4. Validation window

- **Start:** first UTC hour boundary ≥ the lock commit timestamp (data logged between W1 close and lock is design corpus, not W2).
- **Duration:** **14 days** (≈ 1,344 KXBTC15M signals; ≈ 790 expected fills at W1's 59% fill rate). 72h was rejected by arithmetic: at the observed per-trade sd (~48¢, = 100·√(p̄(1−p̄)) for midrange binary entries), 72h yields ~170 fills — an expected NO-GO (execution) on G3 before any signal question is asked.
- **Single pre-specified interim look at day 7** (§8a): early GO permitted only at a deliberately harsh bound (one-sided z ≥ 2.8 with all other gates passing at interim); otherwise CONTINUE, with **only the boolean disclosed** — no point estimates, no per-stratum numbers — so a continue-look leaks minimal information to the operator.
- **Eligibility:** the existing holdout policy applied to the W2 span — worst-channel coverage ≥ 99%, no channel with a continuous gap > 1h, per `isContinuousHoldoutEligible()`. An ineligible window is scored as **NO-GO (data)**, not retried silently; the next clean 14-day span becomes W2′ under this same document.

**Operating characteristics** (Monte Carlo, 20k trials/row, all P&L gates jointly — G1, G2 one-sided z≥1.70 final / z≥2.8 interim, G3, G6 — at sd 48¢, 96 signals/day, 59% fill):

| True edge | P(GO) | P(early day-7 GO) |
|---|---|---|
| 0¢ | **3.4%** | 0.3% |
| +2.5¢ | 36.3% | 3.7% |
| +3.83¢ (W1 disciplined estimate) | 65.9% | 10.9% |
| +7¢ (W1 undisciplined estimate) | 98.8% | 54.7% |

Read before interpreting any verdict: a NO-GO at a true +2.5¢ edge is the *most likely outcome* (64%) — the gates are sized to admit only edges meaningfully larger than their own threshold, and the eventual verdict must be read at that weight.

## 5. Trade simulation (what "the signal's P&L" means)

For each ticker: the **first** non-SKIP decision of that ticker's life; 1 contract; hold to settlement (0/1 vs `kalshi_result`). No exits, no re-entries, no size variation.

**Fill rule (anti-quote-fade — the taker mirror of v2 §2.1's maker adverse selection):** a signal at time *t* quoting ask *A* on the fired side fills **only if** the tick archive shows the displayed best ask on that side at *t + 2s* is still ≤ *A*; the fill price is *A* (the signal-time quote, never an improved later one). If the level faded or worsened within 2s, the trade is a **no-fill**: excluded from P&L, counted, and the no-fill rate reported per stratum. The rationale is that the ask you saw is most likely to vanish precisely when the signal is right — marking fills at displayed quotes without a persistence check would let W2 replicate a fade artifact with a tight CI.

**Gate-authority rule (resolved 2026-08-03, before lock):** the **next-scan rule** — fill only if the same ticker's next shadow-log row shows the fired side's ask ≤ *A*. The persistence horizon is therefore *the ticker's actual next scan gap*, not a fixed constant — median ~15s under an eligible window, longer across any scan hiccup (which only makes the rule harsher). A first fire with **no usable fired-side quote** is counted as **unquoted** — never silently dropped — and §4's tripwire applies: unquoted > 2% of settled tickers marks the window suspect (collector degradation hides exactly in that path; W1 measured 0/840 while zero was cheap to prove). The 2s tick-archive variant remains buildable (snapshots + deltas channels both archive) but is **descriptive-only, computed post-lock** if at all: the next-scan numbers are now known, so switching to the shorter-horizon variant — which predictably readmits marginal fades — would be a fork under known incentives. The rule applies identically to S1, S2, and S3.

**W1 leak audit of this rule** (targeted book replay, ±15s around each S1 fill): 13 of 71 fills (18%) showed the ask ticking above *A* within 2s of signal — every one a single-tick fade to the next level 1¢ back. Sensitivity: dropping them → ~+2.2¢/ct; repricing them 1¢ worse → ~+3.7¢/ct (vs +3.83¢ as-scored). **The drop-all-13 figure is a floor, not an estimate** — a single-tick fade at 2s mostly still fills at sub-second live latency — so the truth sits between +2.2¢ and +3.83¢, bracketing the G1 threshold itself. Live note for §11: real taker latency (~1s) is far under the 15s proxy horizon, so Stage B's live fill rate should EXCEED the sim's 59% — a higher live fill rate is expected behavior, not a plumbing fault.

**Fees:** net of the exchange's published taker fee schedule for each series as implemented in the tagged scorer (the general Kalshi formula `0.07 × P × (1−P)` unless the series' schedule differs; the constant actually used is pinned at tag time). Gross-of-fee numbers appear nowhere in gate evaluation.

## 6. No mid-window edits

Scoring path (`worker.ts`, `modelBakeoffLogger.ts`, `brier_bakeoff.py`, strategy/threshold code) and worker env are frozen from lock through W2 scoring. The lock records the code tag and the worker's effective env (`KALSHI_SCAN_INTERVAL_MS` etc.). A crash-restart via the supervised launcher is permitted (it changes uptime, not semantics); any *code or env* change voids the window.

## 7. Interim looks

Prohibited for S1 P&L, with exactly one exception: the §8a day-7 look, computed mechanically by the tagged scorer, disclosing **only** GO or CONTINUE — no point estimates, no per-stratum numbers, no fill counts. Pipeline-health monitoring (log freshness, launchd status, coverage) is permitted and encouraged; it reads liveness, not outcomes. The live board (`motion/live.html`) may run — it displays current-market state, not cumulative W2 P&L; its ledger panel MUST NOT be aggregated by eye into an early verdict that alters any decision. (Peeking cannot be technically prevented; it is hereby made *procedurally meaningless* — §8 evaluated at close, plus the single §8a boolean, are the only decision rules.)

## 8. Gates — S1 (KXBTC15M) only, evaluated once at window close

| # | Gate | Threshold |
|---|---|---|
| G1 | Aggregate net P&L per contract (§5 sim, filled trades only, ceil-to-cent fees) | ≥ **+2.5¢** |
| G2 | **One-sided** test of mean P&L/contract > 0 (directional hypothesis; final bound z ≥ 1.70, α-adjusted for the §8a interim look) | z ≥ **1.70** |
| G3 | Sample size *n* | ≥ **200** |
| G4 | Window eligibility (§4) | eligible |
| G5 | Code/env integrity (§6) | tag match, no edits |
| G6 | Robustness (leave-one-block-out): aggregate P&L/contract with the single best UTC 6h block **removed** | ≥ **+2.5¢** |
| G7 | **Fired-subset Brier vs mid**: on ALL S1 first-fire tickers (fills + no-fills — signal question, no fill conditioning; unquoted rows excluded for lack of a mid, reported), z from **paired per-ticker Brier differences** (mid−model) — unpaired would be wrong, not merely conservative | z ≥ **1.645**, one-sided |

**§8a — interim look (day 7):** computed mechanically by the tagged scorer; early GO iff one-sided z ≥ 2.8 AND G1, G3, G6, G7 all pass on interim data; otherwise the only output is CONTINUE.

G7's form: climatology was a strawman — W1 showed +71.8% skill vs climatology *while losing to mid by 32.9%* overall. The mechanism that matters is winning **on the exceedances**: W1 design-corpus fired-subset result was S1 +4.4% vs mid (z = +1.40, n = 120, suggestive not significant; projects to z ≈ 4.7 at W2's fired n if real), with the monotone S1 > S2 > S3 ordering (+4.4 / +1.0 / −5.7) matching the §2 mechanism.

**Unit of n (G1, G2, G3, and the SE arithmetic all use the same unit):** *n* = settled KXBTC15M tickers whose first non-SKIP decision produced a **fill** under the §5 rule. The ≈288 settlements in 72h is an upper bound, discounted by the no-fire rate (W1 preliminary: ~0%, every settled ticker fired at least once) and the no-fill rate (unknown until the persistence rule runs — this is the number most likely to bite G3). A G3 failure caused *purely* by no-fills is reported as **NO-GO (execution)** — distinct from NO-GO (signal) — since it means the strategy cannot get filled at its marks, which is its own kind of no.

G6 is deliberately leave-one-block-out rather than share-of-total: a share rule goes unstable when total P&L sits near zero (denominator ≈ 0 makes every share explode), while "still clears the gate with the best block removed" is stable everywhere and directly tests that no single regime carried the window.

**All seven → GO** (unlocks §11 Stage B). **Any failure → NO-GO, named by quadrant** so a mixed outcome cannot become an argument:

- **NO-GO (data)** — G4 fails (window ineligible, or the §4/§5 unquoted tripwire trips)
- **NO-GO (execution)** — G3 fails purely on no-fills: the strategy cannot get filled at its marks
- **NO-GO (mechanism)** — G7 fails: the model does not beat the market on its own exceedances; there is no basis for taker edge, and the right next work is *model* research
- **NO-GO (economics)** — G7 passes but a P&L gate (G1/G2/G6) fails: real signal the taker cannot monetize through spread, fee, and fade; the right next work is *maker structure or execution* research, not model work

The policy is not retested on new windows without a *new* prereg naming what changed and why. S2/S3 results are reported alongside with the same metrics and fill rule but carry no authority.

Power note: at W1's observed per-trade dispersion (recorded at lock from official Stage A output; preliminary ≈ 11–13¢ sd), n ≈ 250 filled gives se ≈ 0.8¢ — G1+G2 are comfortably detectable if the true effect is anywhere near the design-corpus +7¢, and a true-zero policy fails with high probability.

## 9. Scoring instrument

`scripts/brier_bakeoff.py` at the post-W1 patch tag (the W1 Stage A run patched the `filled n=0` crash after the W1 freeze lifted; tag: **`w2-scorer-final-20260803`**), plus the §5 replay — **including the fill rule, unquoted counting, pinned fee constants, the full G1–G7 battery, and the §8a `--interim` boolean-only mode** — implemented as the read-only script `scripts/w2_replay_scorer.py`, committed before lock at the same tag. Persistence variant shipped: **next-scan (gate authority, §5)**. The 19h scratchpad scorer is design-corpus tooling and is superseded: note its +7.04¢ BTC figure was marked at displayed quotes with no persistence haircut — the design-corpus number the §5 rule exists to discipline.

## 10. What this window cannot conclude

- Nothing about maker strategies (v2's track), Layer-2 features, other venues, or sizing beyond 1-contract replay.
- A GO does not mean the edge is permanent — it licenses the smallest live test (§11), whose own stop rules assume the edge may be regime-dependent (cf. the Stanford single-name adverse-selection finding cited in v2 §2.1).
- S2/S3 outcomes prove or refute nothing promotable; they calibrate the §2 mechanism story only.

## 11. Stage B pre-commitment (R7-dust, BTC-only) — armed ONLY by a §8 GO

Committed now so a GO cannot be re-litigated into something larger, and a NO-GO cannot be argued into "but let's try small anyway":

```text
venue/account : Kalshi account in live_trading/.env  (balance at draft: ~$43.52 + pending promo)
scope         : KXBTC15M only, same §5 signal, taker limit at ask
size          : 1 CONTRACT per order              [CONFIRMED 2026-08-03 — changed from $5/order]
manual gate   : MANUAL_CONFIRM_FIRST_N = 5        [CONFIRMED 2026-08-03]
evidence stop : cumulative net P&L ≤ −$12.50 (50% of aggregate cap) → TERMINAL halt
plumbing trip : 2 consecutive losing settlements → PAUSE; verify fills/fees/sizes
                match the W2 sim assumptions; resume unless a plumbing fault is found
aggregate cap : $25 total at-risk for the entire R7-dust round   [CONFIRMED 2026-08-03]
duration      : 48h or 40 settled trades, whichever first; then full writeup vs W2 prediction
kill switch   : KALSHI_ALLOW_ORDERS reverts to 0 at any stop condition; plist pin restored
```

**How stops read — pre-specified so an early stop is not an interpretation fight:**
the *evidence stop* (drawdown) counts as **Stage B FAIL** — evidence against the W2 result at live
scale, full stop. The *plumbing trip* is operational, not evidential: a pause that resumes unless
inspection finds the live path diverging from the §5 sim (wrong fills, wrong fees, wrong size, or
**re-fire divergence**: §5 is first-fire-only with no re-fire after a no-fill, so the live worker
must be too — a live re-fire after a missed quote masquerades as extra fills rather than the
sim/live divergence it is), in which case the round is **VOID (plumbing)** and may be restarted
exactly once after the fault is fixed. Expected-behavior note: live taker latency (~1s) is far
below the §5 persistence horizon, so a live fill rate ABOVE the sim's ~59% is anticipated, not a
plumbing fault. Rationale: at any plausible win rate, two consecutive losses arrive before trade 40 with
near-certainty (~99% at 60% win rate, ~95% at 70%), so a *terminal* consecutive-loss stop would
guarantee Stage B never completes its sample — a drawdown stop sized to the cap preserves it.

A NO-GO leaves all order gates at 0/0/0 and R7 CLOSED.

## 12. Amendment log (post-peek changes, direction declared)

All changes made after the W1 19h peek and 30h Stage A results were known, so future readers can discount honestly:

| Change | Direction | Rationale |
|---|---|---|
| Fill rule added (§5, next-scan persistence) | **harshening** | W1 fade diagnostic: no-fills' counterfactual +11.8¢ vs fills +3.83¢ — quote fade was the artifact |
| Fees ceil-to-cent (§5, G1) | **harshening** | exchange rounds up; raw formula flattered by ~0.33¢/trade (verified) |
| G7: climatology → fired-subset-vs-mid (§8) | **harshening** | climatology gate passed at +71.8% while the model lost to mid by 32.9% — strawman replaced by the actual mechanism test |
| Window 72h → 14d (§4) | **neutral/necessary** | sd corrected 11–13¢ → ~48¢ (first-principles binary formula); 72h could not reach G3 |
| G2 two-sided CI → one-sided z ≥ 1.70 (§8) | **softening — justified** | hypothesis is directional; two-sided at corrected sd required a ~7¢ true edge. One-sided is the only softening; α preserved jointly with §8a interim (P(GO\|0) = 3.4% by simulation) |
| §11 stop: terminal 2-consec-loss → drawdown stop + plumbing trip | **neutral** | consecutive-loss stop fired with ~99% probability before sample completion — de facto exit, not a stop |
| Unquoted counter + §4 tripwire (§5) | **counting** | first-fire-without-quote silently dropped; 0/840 in W1 — counter added while zero was cheap to prove |
| Fee determinism `ceil(round(·,9))` (§5 scorer) | **hygiene** | float wobble at exact-cent boundaries was conservative-only; reproducibility for a gate |
| G2 stated in z-form; G7 paired-differences spec; NO-GO quadrant taxonomy (§8) | **wording** | prose now equals code; mechanism/economics quadrants named pre-outcome |
| §11 re-fire parity in plumbing checklist | **counting** | live re-fire after no-fill would masquerade as extra fills |
| §11 sizing: $5/order → 1 contract/order | **neutral — reviewed-equivalence** | at $5 (~10 contracts midrange) the −$12.50 evidence stop sat ~3 net losses deep — P(stop\|true edge) ≈ 55–60% before trade 40, aborting a majority of genuinely good runs as FAIL — and depth/partial fills were live-path assumptions with no shadow analogue. At 1 contract Stage B is an exact replica of the §5 sim (same sizing, same ceil'd fee, top-of-book depth guaranteed), the 40-trade sample completes, and the evidence stop becomes a pure malfunction floor |
| §13 lock delegation recorded | **governance** | operator red-team completed with sign-off standing (2026-08-03) and explicitly delegated the lock commit in-session; the original operator-only provision existed to prevent an unreviewed lock, and review is what happened |
| W2 declared NO-GO (data); W2′ invoked (2026-08-06) | **governance — §4's own rule** | 2026-08-04 outage: 7.96h continuous shadow gap (bar 1h), 33/228 settlement slots missing, ≤97.63% coverage at day 14 — overdetermined void. Declaration: `kx15m-w2-void-declaration-and-w2prime.md`; evidence: `w2-evidence-annex-and-close-protocol.md` |
| §4 tripwire: unquoted counter → fire-coverage (2026-08-06, for W2′) | **harshening** | audit F5: the unquoted counter is structurally dead (post-null-book-gate asks are non-null by construction; 0/840 W1, 0/1,334 W2 — unreachable, not clean). Fire-coverage = settled tickers with zero shadow rows, denominator from the exchange's settled listing (not the validator's own capture, which shrinks under the degradation it must detect — audit F1) |
| Freeze rider: `calibration.json` must remain absent (2026-08-06, for W2′) | **harshening** | audit F7: a dropped-in calibration file hot-loads into fair_yes within 5 min outside §6's "code or env" freeze language; absence is now checked by the close wrapper, converting an accident into a guarantee |
| Fallback spot feed staleness guard (2026-08-06, for W2′) | **harshening — measurement repair** | audit F8: fallback feed served last-good price forever with no age check; stale spot → SKIP (logged). Strictly removes phantom fires against frozen prices; taken openly rather than silently or deferred to W3 |
| §4 power-note erratum (2026-08-06) | **wording — correction** | annex §3: se ≈ 48¢/√n (n=250 → ≈3.0¢, not 0.8¢); a W2′ NO-GO (economics) must not be over-read as evidence of no edge. Locked prose left intact; erratum governs |
| G4 measured in exchange-open time (for W2″, precommit §6) | **neutral/necessary — venue calendar** | Kalshi pauses every Thursday 03:00–05:00 ET, so no wall-clock 14-day span can pass the 1 h gap rule. The wrapper now removes one kind of time only: the part of a no-market interval in the settled listing that overlaps the published pause, padded by one market. An exchange overrun past the pad stays a counted gap, and no time with an open market is excluded. It compresses that time out rather than masking it, so faults on both sides join into one gap. The window is computed in ET, so it follows DST. Incentive direction, named per precommit §6: on the dead span it could only move NO-GO (data) toward the harsher quadrants. Checks: `apps/market-worker/scripts/test_w2_close_check.py` |
| Close wrapper added to `FROZEN_PATHS` (for W2″) | **harshening** | The wrapper that reads the gate lines was not frozen, so it could change mid-window undetected. G5 now diffs it against the instrument tag with the rest of the scoring path |
| G5 reads the running worker's environment (for W2″) | **harshening** | The startup line attested only the scan interval. G5 now reads each worker's own `/proc` environ at the interim and the close. The three order gates must be 0, none of the five decision knobs may be set, and the feed endpoints must equal the env vector committed at lock. An empty read fails |
| Final close enforces the §4 tripwire (for W2″) | **harshening** | The scorer withholds GO on a tripped tripwire only under `--interim`. At the final close it only prints the TRIPWIRE line, and the wrapper read the gate line alone. A tripped tripwire now prints NO-GO (data), per §8. The scorer itself is unchanged |
| Scorer failure is NO-GO (integrity) (for W2″) | **harshening** | A non-zero scorer exit or a missing gate line used to end the close with no verdict and exit 0 |
| API base in the lock env vector (for W2″) | **harshening** | The worker and the listing fetch both read `KALSHI_API_BASE`, so a wrong endpoint would agree with itself. G5 now checks both against the vector |
| Listing fetched 3 h beyond each window edge (for W2″) | **correction** | A window that starts inside a Thursday pause had no close before its start to anchor the pause. So a perfect host failed G4 with a 2.00 h or 1.00 h gap. The padded listing anchors the start edge. At a live close it cannot anchor the end edge. No market after the end has settled when the close runs. The window boundary rule covers the end edge. Reconciliation and the scorer keep the exact span |
| Window boundary rule (for W2″) | **neutral/necessary — venue calendar** | Measured with the wrapper on a perfect host, closed live 5 min after the end. A 14-day window that starts and ends on a Thursday at 04:00 or 05:00 ET fails G4. Its end-edge gap is 1 h plus one scan interval, or 2 h. Windows at 03:00 and 06:00 ET pass. So the W2″ window may not start on a Thursday at 04:00 or 05:00 ET. That is 08:00Z or 09:00Z in daylight time. The lock text states the start hour. Check: `test_live_close_fails_a_window_ending_late_in_the_pause` |
| Fee rounding re-checked (for W2″, 2026-09-21) | **wording — premise update, no code change** | The scorer charges `ceil(0.07·P·(1−P))` per contract, rounded up to the cent. Kalshi's API lists KXBTC15M as `quadratic` with `fee_multiplier` 1 and no recorded fee change. Kalshi now rounds the fee up to $0.000001. It then aligns the balance to $0.0001 for a direct member, or to $0.01 otherwise. For one contract in one fill, a direct member pays less than the scorer charges. The mean excess in W1 was about 0.33¢, per the ceil-to-cent row. A non-direct member pays the scorer's charge at whole-cent prices. Below 10¢ and above 90¢ the tick is 0.1¢, and there the two differ by under 1¢ either way. The account type decides the direction. The fee-schedule PDF refused the download (HTTP 429), so the 0.07 coefficient was not re-read from it |
| Env vector file frozen (for W2″) | **harshening** | The lock env vector is `apps/market-worker/scripts/w2pp-env-vector.json`. G5 compares each worker's endpoints to it. The file is now in `FROZEN_PATHS`, so an edit during the window shows in G5's diff against the tag. Before, G5 would have compared the workers to the edited vector |
| Freeze check fails closed on a git error (for W2″) | **harshening** | G5 read an empty `git diff` as clean. A tag missing from the checkout makes git exit 128 with empty output, so G5 would have passed. It now fails on any git error. Check: `test_freeze_fails_closed_on_a_missing_tag` |
| Fee direction confirmed (for W2″, 2026-09-21) | **harshening — no code change** | The operator confirmed that the Stage B account is a direct Kalshi member. For one contract in one fill, the scorer rounds the fee up to the cent, and the exchange rounds it up to $0.0001. So the scorer is harsher than the exchange or equal to it on every trade |
| Gate line parsed exactly (for W2″, review of `700daae`) | **harshening** | The wrapper searched the gate line for `(FAIL)`, so an incomplete line such as `gates: G1(PASS)` printed GO. It now requires exactly one gate line, with exactly G1, G2, G3, G6 and G7, each PASS or FAIL, and only the scorer's own bound note after them. Anything else is NO-GO (integrity). Check: `test_w2_close_review.py` |
| Interim output exact (for W2″, review of `700daae`) | **harshening** | The day-7 interim took the scorer's last line as its verdict, whatever it said. It now accepts only one line reading GO or CONTINUE. Anything else is NO-GO (integrity) |
| Settlement identity reconciled (for W2″, review of `700daae`) | **harshening** | Reconciliation compared ticker names only. It now fails the window as NO-GO (data) on a local settlement absent from the exchange listing, on a ticker whose close time or result differs between the two, on a conflicting duplicate, on a malformed row, or on an empty listing. Both W2′ closes had no local-only ticker, and a test run 305 s after a boundary had none, so a healthy host should not trip it |

## 13. Locking procedure

This document is LOCKED by the commit with message `prereg: lock KX15M_FV_TAKER_BTC_W2`, with §9's blanks filled and §11's three confirmations recorded, landing **before** the §4 window start. The lock commit hash is then appended here in a single follow-up commit.

Provenance of the lock authority: the draft originally reserved the lock commit to the operator alone. The operator's red-team reviewed the instrument line-by-line (fill block, fee function, thresholds, OC verification — all independently reproduced), signed off on 2026-08-03, confirmed §11's three envelope parameters (sizing adjusted to 1 contract on the reviewer's own analysis), and explicitly delegated the commit in-session: *"Adjust or annotate, then lock — the clock's waiting on an hour boundary, not on me."* The provision's purpose — no unreviewed lock — is satisfied; the delegation is recorded in §12.

**Lock commit hash:** `dbbe3e1`
