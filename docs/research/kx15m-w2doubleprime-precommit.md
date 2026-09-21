# W2″ Continuation Pre-Commit — recorded blind, before any dead-span read

**Status:** OPERATOR DECLARATION (mirrors the lock's provenance discipline, §13 of the prereg)
**Date:** 2026-08-14 · **Instrument tag:** `w2prime-instrument-20260806`
**Governing text:** `kx15m-w2-btc-stratified-shadow-preregistration.md` §4 (eligibility), §7 (interim looks), §12 (amendment log)
**Sequencing proof:** this file's commit precedes any read of W2′ span outcomes; the commit
hash and parent order are the record. At commit time the only outcome-adjacent disclosures
that exist are the §8a day-7 boolean (`NO-GO (data)`, 2026-08-13T10:05Z, wrapper) and the
wrapper's eligibility sub-checks — coverage, gaps, reconciliation counts, freeze status —
all liveness reads permitted by §7. No scorer gate line, point estimate, fill count, or
per-stratum number has been computed or seen.

---

## 1. Standing of W2′ (facts known at commit time)

The W2′ span (2026-08-06T10:00Z → 2026-08-20T10:00Z) is **§4-ineligible** as of 2026-08-13:

- Shadow gap 2026-08-13T06:45:12Z → 09:00:10Z (**2.25 h continuous** > 1 h bar); span
  shadow coverage 98.47% (< 99% bar).
- Both orderbook collector channels: 2 consecutive missing hour-files, worst-channel
  coverage 98.81% (< 99% bar).
- Day-7 interim (sanctioned wrapper, 2026-08-13T10:05Z): **NO-GO (data)**.
- Settlement reconciliation 662/664 (0.30%, under the 2% tripwire) and G5 freeze CLEAN
  (tag match, no edits, calibration.json absent, env attested): the instrument is healthy;
  the site is not.

The 2026-08-20T10:05Z close will record **NO-GO (data)** mechanically; the wrapper fails
G4 before the scorer is consulted. Nothing in this document waits on that close.

## 2. Root-cause status (known at commit time)

Two outages with identical clock boundaries, one week apart: Thu 2026-08-06
06:45→09:00:31Z and Thu 2026-08-13 06:45→09:00:10Z (01:45→04:00 America/Chicago) — a
scheduled weekly site event, not weather. Site-wide, not host-local: the Pi dual-run
archive lost the same hours (orderbook/tickers/trades jump T06→T09 on 08-13) while its
services stayed active. Consequence: **every 14-day span at this site contains ≥ 2
Thursdays**, breaching both the gap rule and (at two outages) the 99% coverage bar — no
eligible span exists here until the cause is cured. Diagnosis is pending and is **not**
an input to this document.

## 3. Pre-commitment (the decision, made blind)

**W2″ WILL be run under `kx15m-w2-btc-stratified-shadow-preregistration.md` unchanged** —
same thresholds, semantics, duration, gate battery, fill rule, and boolean-only interim
discipline — once §4 of this document is satisfied, **regardless of the contents of any
dead span (W2 or W2′)**. The continue decision derives solely from the W1 evidence that
justified W2 at lock (disciplined bracket [+2.2¢, +3.83¢]; fired-subset paired Brier
mechanism present where predicted, monotone S1 > S2 > S3). Nothing read after this commit
can enlarge, shrink, or cancel this commitment.

## 4. Start condition (site-cure gate)

W2″ start anchor = first clean UTC hour boundary after **cure verification**, defined as:

1. Root cause of the weekly Thursday 06:45–09:00Z outage identified, AND
2. eliminated or routed around, AND
3. at least one full Thursday 06:00–10:00Z window subsequently observed with zero
   shadow gaps > 1 min on the scoring host.

Host: per the Pi-migration plan, the Aug-20 boundary cutover stands and the next lock
records the Pi env. The cure is orthogonal to host choice — the outage hits both hosts.

## 5. Dead-span read disclosure (§12-logged, direction named in advance)

After this commit, the operator has ordered a **descriptive read** of the W2′ dead-span
scorer output (operator mandate, 2026-08-14, given after two rounds of recorded
counter-argument from the session instrument-runner; the recommendation against is part
of this record). Terms of the read:

- It carries **no gate authority**; the span remains unscored for decision purposes.
- Direction of incentive, named before reading: a favorable read tempts treating §3 as
  confirmed; an unfavorable one tempts abandonment or redesign. §3 is worded to be
  insensitive to both, and its authority derives from preceding the read.
- Any W2″ design change beyond §4's cure gate that is proposed **after** the read is
  presumptively a fork under known incentives and requires its own §12 entry naming what
  was seen and why the change is nonetheless sound.
- The W2-void blind-statement precedent (dead spans permanently unread, void declaration
  §1/§5) is **broken by this read**, by explicit operator decision. Future documents must
  not cite that precedent as unbroken.

## 6. Addendum — root cause resolved (2026-08-14, recorded post-read)

**The "site outage" does not exist. The root cause is Kalshi's published weekly
maintenance window: every Thursday 3:00–5:00 AM ET = 07:00–09:00 UTC, with a trading
pause** (docs.kalshi.com, "Maintenance and Pauses"). Evidence chain, none of it derived
from any P&L number:

1. During the 08-13 window, the Pi's tailscaled established fresh DERP connections
   (dfw/ord/sea, 35–41 ms) — the WAN was up; the Pi's Ethernet link never dropped.
2. The exchange's own settled listing shows **zero** KXBTC15M closes between 06:45Z and
   09:15Z on Thursday, against a full 4-per-hour cadence at those hours on all six other
   weekdays. There was nothing to collect.
3. Shadow-log recovery at 09:00:10Z (08-13) and 09:00:31Z (08-06) — the pause's end.

Corrections to the record: §2 of this document (mechanism: "scheduled weekly site event
… router/ISP/DNS") is wrong as to mechanism; no site fault exists. Void declaration §6b's
"connectivity outage" at the W2′ start was the same exchange pause, misdiagnosed. The
Aug-4 7.96 h hole that voided W2 remains a genuine machine-wide power outage — unrelated.

Consequence for §4 (cure gate): "eliminated or routed around" is inapplicable to the
venue's own calendar. The cure is definitional: **W2″'s lock must carry a §12-logged
amendment computing G4's coverage denominators and continuous-gap rule over
exchange-open time** (per the exchange's published pause windows, verified against its
settled listing), not wall-clock. This amendment is sound independent of any dead-span
outcome — it follows from the venue calendar alone, and without it no 14-day window on a
24/7-minus-maintenance venue can ever be eligible. Per §5 it is flagged as proposed
post-read; its incentive direction is named: on the dead span it could only reclassify
NO-GO (data) toward the harsher quadrants, never toward GO. §4(3) is restated
accordingly: one Thursday observed where the only capture gap is the published
maintenance window.

W2′ disposition unchanged: it closes 2026-08-20T10:05Z as **NO-GO (data)** under its
locked text — no mid-window edits (prereg §6), even ones that would only make the verdict
harsher. The 08-20 Thursday pause sits inside the span's final hours; expected, no action.

## 7. W2″ lock record (2026-09-24)

**Status:** DRAFT. The lock commit fills every `⟨fill at lock⟩` field and removes this line.

**Window.** 2026-09-24T10:00:00Z → 2026-10-08T10:00:00Z. The §8a day-7 interim fires
2026-10-01T10:05Z and the close fires 2026-10-08T10:05Z, both through the close wrapper.
The start is 06:00 ET on a Thursday, so it obeys the §12 window boundary rule (not 04:00 or
05:00 ET).

**§4(3) cure record.** One full Thursday observed on the scoring host 1705bonzos, where the
only capture gap is the published pause. Soak start 2026-09-21T21:00:03Z, the first passing
read-back after the host reboot. Thursday 2026-09-24 dry run with the amended wrapper and
`--env-vector`: `⟨fill at lock: G4 and G5 lines, and the gap list⟩`.

**Instrument.** Tag `w2pp-instrument-20260924` on commit `⟨fill at lock⟩`. GitHub release
created `⟨fill at lock⟩` (server time). The worker and collector started 2026-09-21T20:56Z
from `532ff06`. `git diff --name-only 532ff06 w2pp-instrument-20260924 -- apps/market-worker/src
apps/data-collector/src packages` is `⟨fill at lock: empty⟩`, so the running code is the
tagged code.

**Env-at-lock vector.** The frozen file `apps/market-worker/scripts/w2pp-env-vector.json`:
`{"KALSHI_API_BASE": "https://api.elections.kalshi.com/trade-api/v2"}`. At
`⟨fill at lock⟩` each worker's `/proc` environ showed `KALSHI_ALLOW_ORDERS=0`,
`KALSHI_AUTO_SUBMIT=0`, `KALSHI_DUST_ENABLED=0`, that API base, and no knob.

**Host during the window.** Beside OS housekeeping, 1705bonzos runs only these:

- `kalshi-worker.service` and `kalshi-collector.service`, the instrument. The collector
  writes to the SD card. The external disk is removed and its mount unit masked.
- `w2pp-day7-interim.timer` and `w2pp-close.timer`, installed `⟨fill at lock⟩`.
- `bookA-watchdog.service`, an account watchdog unrelated to Kalshi, kept on the operator's
  decision.
- `⟨fill at lock: the operator's line for the Robinhood poller timer, or "no poller"⟩`
- A liveness monitor on another host opens one ssh session every 5 min. It reads unit
  states, file times and names, the worker environ and board sensors, never a data row.

The operator keeps the full host change log, each change with its undo, for the restore
after the close.

**Economic declaration.** obi commit `⟨fill at lock⟩`, GitHub release `⟨fill at lock⟩`,
declares the holdout window `w2pp-holdout-20260924` and the economic design before
10:00Z.

**Lock authority.** `⟨fill at lock: the operator's words and time⟩`.
