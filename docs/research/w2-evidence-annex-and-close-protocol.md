# W2 Evidence Annex and Close Protocol

**Status:** Bin C evidence document per `kx15m-w2-void-declaration-and-w2prime.md` §4
**Date:** 2026-08-06 · Companion to `kx15m-w2-btc-stratified-shadow-preregistration.md`
Closes or arms audit findings F1, F2, F3 (partial), F11, F12, F13, F19, F20 (`analysis/feynman-audit-20260805.md`).

---

## 1. Fee provenance and the F3 band result (F3, F18-partial)

**Band analysis (closes the blast-radius question).** Post-ceil, the contested coefficients
0.07 and 0.0625 produce **identical per-contract fees at every integer price except
{18, 19, 20, 80, 81, 82}¢**, where they differ by exactly 1¢ (verified by direct
computation over all 99 prices; script inline in §6). Against W1's fill-price
distribution: **0 of 92 S1 (KXBTC15M) fills** land in a divergence band — S1 fills span
21–76¢ with mass at 37–55¢. Five band fills exist across all strata (2× DOGE, 1× BNB,
1× ETH, 1× XRP), all non-promotable. **Therefore the W1 G1 bracket (+2.2¢ → +3.83¢) is
coefficient-invariant, and F3 reduces to pure provenance debt**: mandatory before Stage B
(live pays the real schedule), but not a G1-flipper on any evidence in hand.
Replay note: this check scores 92 S1 fills over all pre-lock shadow rows (design corpus +
W1) vs the prereg's official 71 over the W1 span proper; the band result holds over the
superset, so it is robust to the span-definition difference.

**Provenance (still owed):** the Kalshi taker-fee schedule for KX*15M as of the lock date,
archived with SHA-256, reconciling 0.07 vs the fee doc's "~1.5625¢ peak" prose line and
retro-satisfying `kalshi-fee-assumption-kxbtc15m.md` §7. Until archived, the scorer's 0.07
stands on: line 16 of that doc ("0.07%–7% sliding") being arithmetically consistent only
with 0.07, and Kalshi's widely-cited general formula. F3 stays open-as-provenance until
the archive lands.

## 2. Settlement-slot re-derivation (corrects the audit headline figure)

As of 2026-08-06T04:00Z, from window start 2026-08-03T19:00Z, measured two ways:

- **Local slot arithmetic:** 228 expected quarter-hour slots, 195 captured, **33 missing**.
- **Exchange-authoritative** (settled listing fetched by `w2_close_check.py`, the F1/F5
  denominator): **229 settled on the exchange, 195 captured, 34 missing** — the outage
  cluster (2026-08-04 ≈13:45Z→01:45Z capture gap) plus the two 2026-08-03 21:15–21:38Z
  worker-blip markets (the sub-1h loss class G4 cannot see — audit F1's example, measured).

The audit headline's **34 was correct against the exchange denominator**; the local 33 is
a slot-boundary rounding artifact — a working demonstration of why the tripwire denominator
must be the exchange's list, not any local reconstruction. Nothing rests on the exact
count: the 7.96 h continuous shadow gap (2026-08-04T17:34:49Z → 2026-08-05T01:32:28Z)
carries the verdict alone under §4's >1 h rule. Dry-run record: the wrapper, run over the
dead span as plumbing test data per the declaration's blind statement, printed
`NO-GO (data)` with G4 FAIL (shadow 85.37%, worst-channel 87.72%, max gap 7.96 h) and
correctly flagged the in-flight maintenance edits as a G5 freeze violation.

## 3. Erratum — §4 power note (F19)

The locked prereg's line 113 reads "preliminary ≈ 11–13¢ sd), n ≈ 250 filled gives
se ≈ 0.8¢". This uses a dispersion figure the same document's §4 and §12 corrected to
**≈48¢** (= 100·√(p̄(1−p̄)) for midrange binary entries). Corrected arithmetic:
**se ≈ 48¢/√n** → at n = 250, **se ≈ 3.0¢** (≈4× the stated figure); at the full
n ≈ 790 expected fills, se ≈ 1.7¢. Consequence for interpretation: a NO-GO (economics)
at W2′ scale is **compatible with a true edge of a few cents** and must not be over-read
as evidence of no edge; the OC table (§6) already embodies the corrected sd — this
erratum aligns the prose with it. The locked text itself is not edited (lock discipline);
this erratum is the governing correction, referenced from §12.

## 4. Env-at-lock attestation (F13)

§6 promised "the lock records the code tag and the worker's effective env"; both lock
commits touched only the doc. Recorded here from runtime evidence gathered 2026-08-05/06:

- Every worker start in the window logs `starting; scan interval 15000ms; port 4001` —
  i.e. `KALSHI_SCAN_INTERVAL_MS` at the code default **15000**.
- Audit closure (skeptic GAP-11) attested the full load-bearing vector at code defaults —
  `KALSHI_SCAN_INTERVAL_MS=15000`, `SIGMA_MULTIPLIER`, `MIN_Z_DISTANCE`,
  `CALIBRATION_ALPHA` all defaults — with no mid-window plist edit (loaded plists
  byte-identical to repo copies).
- Standing rule from this annex forward: **the W2′ lock commit must include this vector
  in-document**, and the close wrapper (§5) diffs the frozen paths against the tag —
  attestation becomes computed, not observed.
- Freeze rider (F7, §12-logged): `apps/market-worker/logs/calibration.json` **must remain
  absent** for the entirety of any frozen window; the wrapper fails the window if the file
  exists or has existed (mtime/journal evidence) inside the span.

## 5. Mechanical close protocol (F2, F20 — arms F1)

No gate line — interim or final — is read from the bare scorer again. The instrument is
`apps/market-worker/scripts/w2_close_check.py` (Bin A), which in order:

1. **G4 (eligibility):** adequacy over the exact span — worst-channel coverage ≥ 99% AND
   no continuous gap > 1 h (shadow log and collector channels both) — computed, not assumed.
2. **Reconciliation (F1):** fetches Kalshi's settled listing for the span (one exchange
   fetch), reconciles against `kalshi-settlement-validation.jsonl`, reports missing slots;
   the same listing is the **fire-coverage denominator (F5)**: settled tickers with zero
   shadow rows, replacing the structurally-dead unquoted counter as the §4 tripwire.
3. **G5 (freeze):** git-diff of the frozen paths against the instrument tag; env vector
   check; calibration.json absence check.
4. Only if 1–3 pass does it invoke the scorer and surface the gate line, naming the NO-GO
   quadrant from the printed gates. `--interim` mode runs the same battery and discloses
   the boolean only — but a 1–3 failure prints `NO-GO (data)`/`NO-GO (integrity)`, never
   a bare `GO`.
5. §12 note: the score-once discipline and window boundaries remain procedural (F20) —
   the wrapper enforces eligibility and integrity, not operator honesty; that is what the
   declaration's provenance discipline is for.

## 6. Reproducibility commitments (F11, F12)

- **OC Monte Carlo** (`apps/market-worker/scripts/oc_monte_carlo.py`): reproduces the §4
  operating-characteristics table — 20k trials/row, G1/G2/G3/G6 jointly, sd 48¢,
  96 signals/day × 59% fill, day-7 interim at z ≥ 2.8 + final z ≥ 1.70 — committed with
  its output at the W2′ tag lineage. The claimed P(GO | edge = 0) = 3.4% becomes
  checkable; if the committed run disagrees materially, the §12 log records the true OC
  before W2′ starts.
- **W1 fade audit** (`apps/market-worker/scripts/w1_fade_audit.py`): replays the book
  ±15 s around each W1 S1 fill from the collector tick archive, recomputing the
  "13 of 71 fills fade within 2 s" claim and the +2.2¢/+3.7¢ sensitivity brackets;
  committed with output where the archive spans the fills, with unreachable fills
  enumerated rather than skipped.
- Band-divergence check (§1): `ceil(round(c·p·(1−p)·100, 9))/100` for c ∈ {0.07, 0.0625}
  over p = 0.01…0.99 — divergence exactly at {18, 19, 20, 80, 81, 82}¢.

## 7. Settlement-methodology provenance (F14 — owed, not yet closed)

Still required before Stage B: an archived excerpt of Kalshi's KX*15M rulebook specifying
the 60 s BRTI-mean settlement window, the tie rule (ties → YES), result-publication lag,
and void/scratch semantics — plus a decision on thin-side rows (the AND-semantics
rejection at `settlementValidator.ts:212`) and whether the 89.4% BRTI-authority statistic
excluded them. Listed here so the debt is visible; not blocking W2′ (shadow scoring), but
blocking any Stage B arming per the runbook.
