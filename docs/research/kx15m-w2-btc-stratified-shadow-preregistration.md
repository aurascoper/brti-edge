# Pre-registration: `KX15M_FV_TAKER_BTC_W2` — BTC-primary stratified shadow test

**Status:** **DRAFT — NOT LOCKED** (locking = operator commit of this file; see §12)
**Created:** 2026-08-02
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
- **Duration:** 72 hours (≈ 288 KXBTC15M settlements at 4/hour).
- **Eligibility:** the existing holdout policy applied to the W2 span — worst-channel coverage ≥ 99%, no channel with a continuous gap > 1h, per `isContinuousHoldoutEligible()`. An ineligible window is scored as **NO-GO (data)**, not retried silently; the next clean 72h span becomes W2′ under this same document.

## 5. Trade simulation (what "the signal's P&L" means)

For each ticker: the **first** non-SKIP decision of that ticker's life; 1 contract; hold to settlement (0/1 vs `kalshi_result`). No exits, no re-entries, no size variation.

**Fill rule (anti-quote-fade — the taker mirror of v2 §2.1's maker adverse selection):** a signal at time *t* quoting ask *A* on the fired side fills **only if** the tick archive shows the displayed best ask on that side at *t + 2s* is still ≤ *A*; the fill price is *A* (the signal-time quote, never an improved later one). If the level faded or worsened within 2s, the trade is a **no-fill**: excluded from P&L, counted, and the no-fill rate reported per stratum. The rationale is that the ask you saw is most likely to vanish precisely when the signal is right — marking fills at displayed quotes without a persistence check would let W2 replicate a fade artifact with a tight CI.

*Fallback, named now:* if parsing the collector's delta archive proves infeasible before lock, the persistence check degrades to the next-scan rule — fill only if the same ticker's next shadow-log scan (~15s later) shows the fired side's ask ≤ *A* — which is strictly harsher. Whichever rule ships in the tagged scorer is recorded at lock and applies identically to S1, S2, and S3 (under optimistic marking, S3 "edges" reappearing would measure artifact stability, not mechanism failure — the falsification control is only meaningful under the same fill discipline).

**Fees:** net of the exchange's published taker fee schedule for each series as implemented in the tagged scorer (the general Kalshi formula `0.07 × P × (1−P)` unless the series' schedule differs; the constant actually used is pinned at tag time). Gross-of-fee numbers appear nowhere in gate evaluation.

## 6. No mid-window edits

Scoring path (`worker.ts`, `modelBakeoffLogger.ts`, `brier_bakeoff.py`, strategy/threshold code) and worker env are frozen from lock through W2 scoring. The lock records the code tag and the worker's effective env (`KALSHI_SCAN_INTERVAL_MS` etc.). A crash-restart via the supervised launcher is permitted (it changes uptime, not semantics); any *code or env* change voids the window.

## 7. Interim looks

Prohibited for S1 P&L. Pipeline-health monitoring (log freshness, launchd status, coverage) is permitted and encouraged; it reads liveness, not outcomes. The live board (`motion/live.html`) may run — it displays current-market state, not cumulative W2 P&L; its ledger panel MUST NOT be aggregated by eye into an early verdict that alters any decision. (Peeking cannot be technically prevented; it is hereby made *procedurally meaningless* — §8 is the only decision rule and it runs once.)

## 8. Gates — S1 (KXBTC15M) only, evaluated once at window close

| # | Gate | Threshold |
|---|---|---|
| G1 | Aggregate net P&L per contract (§5 sim, filled trades only) | ≥ **+2.5¢** |
| G2 | 95% CI lower bound on mean P&L/contract | > **0¢** |
| G3 | Sample size *n* | ≥ **200** |
| G4 | Window eligibility (§4) | eligible |
| G5 | Code/env integrity (§6) | tag match, no edits |
| G6 | Robustness (leave-one-block-out): aggregate P&L/contract with the single best UTC 6h block **removed** | ≥ **+2.5¢** |
| G7 | Decision-time Brier skill of `p_gaussian` vs climatology on S1 settled set | ≥ **+5%** |

**Unit of n (G1, G2, G3, and the SE arithmetic all use the same unit):** *n* = settled KXBTC15M tickers whose first non-SKIP decision produced a **fill** under the §5 rule. The ≈288 settlements in 72h is an upper bound, discounted by the no-fire rate (W1 preliminary: ~0%, every settled ticker fired at least once) and the no-fill rate (unknown until the persistence rule runs — this is the number most likely to bite G3). A G3 failure caused *purely* by no-fills is reported as **NO-GO (execution)** — distinct from NO-GO (signal) — since it means the strategy cannot get filled at its marks, which is its own kind of no.

G6 is deliberately leave-one-block-out rather than share-of-total: a share rule goes unstable when total P&L sits near zero (denominator ≈ 0 makes every share explode), while "still clears the gate with the best block removed" is stable everywhere and directly tests that no single regime carried the window.

**All seven → GO** (unlocks §11 Stage B). **Any failure → NO-GO**: the policy is not retested on new windows without a *new* prereg naming what changed and why. S2/S3 results are reported alongside with the same metrics and fill rule but carry no authority.

Power note: at W1's observed per-trade dispersion (recorded at lock from official Stage A output; preliminary ≈ 11–13¢ sd), n ≈ 250 filled gives se ≈ 0.8¢ — G1+G2 are comfortably detectable if the true effect is anywhere near the design-corpus +7¢, and a true-zero policy fails with high probability.

## 9. Scoring instrument

`scripts/brier_bakeoff.py` at the post-W1 patch tag (the W1 Stage A run patches the `filled n=0` crash after the W1 freeze lifts; that tag is recorded HERE at lock: `____________`), plus the §5 replay — **including the fill rule (persistence check or named fallback) and the pinned fee constants** — implemented as a read-only script committed *before* lock. Which persistence variant shipped (2s tick-archive or next-scan fallback) is recorded here at lock: `____________`. The 19h scratchpad scorer is design-corpus tooling and is superseded: note its +7.04¢ BTC figure was marked at displayed quotes with no persistence haircut — the design-corpus number the §5 rule exists to discipline.

## 10. What this window cannot conclude

- Nothing about maker strategies (v2's track), Layer-2 features, other venues, or sizing beyond 1-contract replay.
- A GO does not mean the edge is permanent — it licenses the smallest live test (§11), whose own stop rules assume the edge may be regime-dependent (cf. the Stanford single-name adverse-selection finding cited in v2 §2.1).
- S2/S3 outcomes prove or refute nothing promotable; they calibrate the §2 mechanism story only.

## 11. Stage B pre-commitment (R7-dust, BTC-only) — armed ONLY by a §8 GO

Committed now so a GO cannot be re-litigated into something larger, and a NO-GO cannot be argued into "but let's try small anyway":

```text
venue/account : Kalshi account in live_trading/.env  (balance at draft: ~$43.52 + pending promo)
scope         : KXBTC15M only, same §5 signal, taker limit at ask
max notional  : $5 per order                      [OPERATOR-DEFAULT — confirm]
manual gate   : MANUAL_CONFIRM_FIRST_N = 5        [OPERATOR-DEFAULT — confirm]
evidence stop : cumulative net P&L ≤ −$12.50 (50% of aggregate cap) → TERMINAL halt
plumbing trip : 2 consecutive losing settlements → PAUSE; verify fills/fees/sizes
                match the W2 sim assumptions; resume unless a plumbing fault is found
aggregate cap : $25 total at-risk for the entire R7-dust round   [OPERATOR-DEFAULT — confirm]
duration      : 48h or 40 settled trades, whichever first; then full writeup vs W2 prediction
kill switch   : KALSHI_ALLOW_ORDERS reverts to 0 at any stop condition; plist pin restored
```

**How stops read — pre-specified so an early stop is not an interpretation fight:**
the *evidence stop* (drawdown) counts as **Stage B FAIL** — evidence against the W2 result at live
scale, full stop. The *plumbing trip* is operational, not evidential: a pause that resumes unless
inspection finds the live path diverging from the §5 sim (wrong fills, wrong fees, wrong size), in
which case the round is **VOID (plumbing)** and may be restarted exactly once after the fault is
fixed. Rationale: at any plausible win rate, two consecutive losses arrive before trade 40 with
near-certainty (~99% at 60% win rate, ~95% at 70%), so a *terminal* consecutive-loss stop would
guarantee Stage B never completes its sample — a drawdown stop sized to the cap preserves it.

A NO-GO leaves all order gates at 0/0/0 and R7 CLOSED.

## 12. Locking procedure

This document is LOCKED when the operator (not the assistant) commits it with message `prereg: lock KX15M_FV_TAKER_BTC_W2`, fills §9's tag blank and §11's three OPERATOR-DEFAULT confirmations, and the commit lands **before** the §4 window start. The lock commit hash is then appended here in a single follow-up commit. Until then: DRAFT, no standing.
