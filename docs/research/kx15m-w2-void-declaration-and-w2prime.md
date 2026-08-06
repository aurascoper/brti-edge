# W2 Void Declaration — NO-GO (data) — and W2′ Restart Protocol

**Status:** OPERATOR DECLARATION (mirrors the lock's provenance discipline, §13 of the prereg)
**Date:** 2026-08-06T04:15Z · **Instrument:** `KX15M_FV_TAKER_BTC_W2` (lock `dbbe3e1`/`7a71347`, tag `w2-scorer-final-20260803`)
**Governing text:** `kx15m-w2-btc-stratified-shadow-preregistration.md` §4 (eligibility), §12 (amendment log)
**Evidence detail:** `w2-evidence-annex-and-close-protocol.md` · **Audit:** `analysis/feynman-audit-20260805.md`

---

## 1. Verdict

The W2 window (start 2026-08-03T19:00Z, the first UTC hour boundary after lock) is declared
**NO-GO (data)** under the locked text's own rule:

> §4 — "An ineligible window is scored as **NO-GO (data)**, not retried silently; the next
> clean 14-day span becomes W2′ under this same document."

The next clean span becomes **W2′ under this same document** (start rule in §6 below).
The dead span's P&L is **not scored** and will not be (§5, blind statement).

## 2. Evidence (outage record)

A machine-wide power outage on 2026-08-04 produced:

- **Shadow-log hole: 2026-08-04T17:34:49Z → 2026-08-05T01:32:28Z (7.96 h continuous).**
  The §4 eligibility rule voids any window containing a continuous gap > 1 h. This alone
  carries the verdict — no coverage arithmetic is required.
- **Settlement capture: 33 of 228 expected KXBTC15M quarter-hour slots missing** as of
  2026-08-06T04:00Z — ≈32 slots inside the outage capture gap (17:30Z→01:45Z) plus ≈2 in
  the separate 2026-08-03 21:15–21:38Z worker-only blip. (This re-derives and corrects the
  audit headline's 34-of-224; nothing rested on that figure — the gap rule is decisive.)
- **No recovery path:** scored generously at day 14 with zero further loss, worst-channel
  coverage lands at ≤ **97.63%** against the ≥ 99% bar. The verdict is fixed regardless of
  the remaining twelve days; waiting would burn them collecting data for a decided outcome.

The verdict is therefore **overdetermined**: gap rule, coverage bar, and settlement capture
each independently void the window.

## 3. Watcher stand-down

The §8a day-7 interim watcher (`com.aurascoper.w2-day7-interim`, Aug 10) and the day-14
close watcher (`com.aurascoper.w2-close`, Aug 17) are **stood down with this declaration**.
On a void window the interim can only emit theater — and per audit **F2** (the scorer's
`--interim` computes neither G4 nor G5 and swallows all diagnostics), the theater could
print `GO`. Fresh watchers are armed at W2′ lock, pointed at the close wrapper (§4, annex
item 4), never at the bare scorer.

## 4. Maintenance window — binned work

The void legally opens the maintenance window the 14-day freeze forbade. All work lands in
one of three permitted bins before W2′ starts; the fourth bin is forbidden.

**Bin A — conformance to the locked text (no amendment needed; the code was failing the spec):**
- Mechanical G4+G5 close wrapper (`w2_close_check.py`) — §4/§6 already require eligibility
  and freeze integrity; the wrapper makes them computed instead of honor-system, and its
  one exchange fetch arms both F1's settlement reconciliation and F5's denominator.
- F19 erratum (power-note arithmetic; annex §3).
- F13 env-at-lock attestation (annex §4).
- F6 gzip crash-append fix (collector persistence).
- F10 legacy-orderbook unit guard (kalshi-client).

**Bin B — harshening amendments, §12-logged with direction declared:**
- **F5:** the structurally-dead unquoted counter is replaced by **fire-coverage** — settled
  tickers with zero shadow rows, denominator taken from the **exchange's settled listing**
  (not the validator's own capture, which shrinks under the same degradation it must detect).
- **F7:** `apps/market-worker/logs/calibration.json` **must remain absent** through any
  frozen window; the close wrapper fails the window if it ever existed.
- **F8:** staleness guard on the fallback spot feed (age check; stale input → SKIP, logged).
  Direction: strictly harshening — it only removes phantom fires against frozen prices.
  Logged as **measurement repair**, taken now rather than silently or deferred.

**Bin C — evidence annex** (`w2-evidence-annex-and-close-protocol.md`): fee provenance with
the F3 band result, settlement-methodology provenance, OC Monte Carlo and W1 fade-audit
scripts committed with outputs, slot-count re-derivation.

**Bin D — FORBIDDEN, stated out loud:** thresholds (G1 +2.5¢, G2 z-bounds, G3 n≥200, G7),
§5 fill-rule semantics, fee constants, window length, stratification, and the §8a interim
design are **not retuned under cover of this restart**. W2′ inherits the same bet at the
same odds. Any future change to these is a new prereg, not an amendment.

## 5. Blind statement

The dead span (2026-08-03T19:00Z → declaration) is design-corpus **structure** but not
**outcome**: its P&L stays unscored forever — nothing decidable can change under this same
document, so peeking buys only prior contamination. Its structure is fair game as plumbing
test data (coverage math, reconciliation counts, fire-coverage dry runs). The F3 fee-band
check used W1, which was always corpus.

## 6. W2′ start rule

W2′ starts at the **first clean UTC hour boundary after the Bin A + Bin B set lands**,
under a fresh instrument tag (`w2prime-instrument-<date>`), freeze re-engaged from that
hour, same document, same thresholds, 14 days, same single day-7 interim — now evaluated
only through the close wrapper. Eligibility is measured by the same §4 rule that just
voided W2, computed continuously rather than discovered by audit.

## 6a. W2′ lock record (appended at restart, 2026-08-06)

The Bin A/B/C set landed as commits `2264e3b` (conformance), `371e754` (amendments),
`a56cad3` (reproducibility) on top of declaration `2c07abb`. Instrument tag:
**`w2prime-instrument-20260806`**. Collector and worker restarted at ~06:40Z so the
running code equals the tag (F6 part-file writer, F8 staleness guard, F10 unit guard
active). **W2′ window: 2026-08-06T07:00:00Z → 2026-08-20T07:00:00Z**, freeze re-engaged
from the start boundary. Watchers armed against the close wrapper (never the bare
scorer): `com.aurascoper.w2prime-day7-interim` (2026-08-13T07:05Z) and
`com.aurascoper.w2prime-close` (2026-08-20T07:05Z); repo copies under
`apps/market-worker/launchd/`. Env-at-lock vector (in-document per annex §4): worker
launchd env with `KALSHI_ALLOW_ORDERS=0`, `AUTO_SUBMIT=0`, `DUST_ENABLED=0`,
`KALSHI_SCAN_INTERVAL_MS` at code default 15000, strategy knobs at code defaults,
`KALSHI_SPOT_MAX_AGE_MS` at new code default 30000, `calibration.json` absent.
Reproducibility note recorded before the window: the OC table reproduces (F11 closed);
the W1 fade-audit archive covers 39/93 fills — the 13/71 figure stands as directionally
supported, not exactly reproduced (annex §6).

## 6b. Start re-anchor (2026-08-06, ~18:40Z — before any window data was consulted)

The 07:00Z start hour turned out not to be clean: a ~2h connectivity outage
(07:00→09:00:31Z; machine awake — pmset shows no sleep) left the worker network-blind
(same PID throughout, zero shadow rows) while the collector's stall watchdog relaunched
it ~every 65s — 224 `.pN` lifecycle part files, which is the F6 fix working exactly as
intended: under the pre-fix writer those restarts would have appended ~110 unreadable
gzip members into two hour files. Under §4's own start rule ("first **clean** UTC hour
boundary"), the start **rolls forward to 2026-08-06T10:00:00Z**; window
**→ 2026-08-20T10:00:00Z**, day-7 interim 2026-08-13T10:05Z. Watchers re-anchored and
re-bootstrapped; measured from 10:00Z: zero gaps, all four collector channels present
every hour, settlement capture at par with elapsed slots. No thresholds, semantics, or
duration changed; the 07:00–10:00Z sliver joins the dead span (unscored). This entry is
the §12-discipline record of the shift.

## 7. Review-chain note (recorded per the lock's provenance discipline)

Two audit findings land on the review chain itself, recorded here as the lock recorded its
delegation: on **F2**, the reviewer asked whether the day-7 early-GO evaluated the full
battery and accepted a claims-level answer ("the full battery, mechanically enforced")
where the standard enforced everywhere else demanded the implementing lines — thresholds
were verified, existence was not. On **F11/F12**, the OC table and the W1 leak audit passed
review as prose plus the reviewer's own analytic cross-check; the committed-artifact
standard imposed on the fee constant should have applied to the numbers that licensed the
thresholds and the fill rule. The audit design caught its own designers — which is the
strongest evidence it works. W2 died of weather; the instrument's real failure was that it
would not have noticed. W2′ runs on one that can.
