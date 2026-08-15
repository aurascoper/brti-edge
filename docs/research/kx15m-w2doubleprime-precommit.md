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
