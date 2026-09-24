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

**Window.** 2026-09-24T17:00:00Z → 2026-10-08T17:00:00Z. The §8a day-7 interim fires
2026-10-01T17:05Z and the close fires 2026-10-08T17:05Z, both through the close wrapper.
The start is 13:00 ET on a Thursday, so it obeys the §12 window boundary rule (not 04:00 or
05:00 ET). The start moved from 10:00Z on the day, because the lock owner's session was not
running at that hour.

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
- The independent Kalshi pilot consumer, installed 2026-09-23 as `obiexec` under the
  amendment below. It stays disarmed until after the close: production entry masked,
  recovery inactive, no consumer or trading journal. It places no order, and it writes
  nothing the instrument reads. So a capture gap remains attributable to the instrument.

**Independent Kalshi pilot amendment (Hunter; installation retained in the amended
implementation request).** The existing “amend that freeze” / “install” authority
permits the separate Kalshi consumer and its required source availability. The
2026-09-23 installation is disarmed: production entry is masked, recovery inactive,
and no consumer or trading journal exists. D1 isolates production as `obiexec` with
private credentials/state and root-owned executable files. The actual instrument
continues as `bonzos`; no worker/collector code, configuration, data or gates changed.
The initial installation changed no source ACL. No Robinhood milestone or §8 GO is an integration dependency;
any independent pilot execution is outside Stage B and cannot enter its writeup.

Initial artifact `f598feb51b3440494dc74795bf3c2931cdbba488d92e98d1aa159708d9ae36f7`, execution hash
`e70dbe62ba5c013f2d160e2a937a2cceecec045ea6f89ca7febabf4626c4d417`, installed 2026-09-23
01:57–02:12Z. Host footprint including retained/staging artifacts: 53136 KiB. Load
snapshots before/after were 1.16/1.16/1.07 and 1.13/1.21/1.15; the clock was synchronized.
The standard readback passed at 02:14:17Z: live collector/shadow data (1 s/2 s), current
hour files, both worker environments with zero order gates, no calibration,
57.9 °C and throttled=0x0. These snapshots do not establish credentialed operating load.

Hunter's later instruction permits demo acceptance on the GPD now; it supersedes the
earlier October 8 provisioning wait and Pi-only demo location. Before any running
consumer is accepted, append its actual activation/hash, owner-verified source pin and
process identity, narrowly scoped source/log access (including rotation), a source
availability endpoint at least the round's original start plus 48 hours, measured
credentialed load/API rate/source lag and alert evidence. Configured limits are 200 MiB
and 25% of one core. No source restart or availability promise is inferred from a service
having no runtime timeout. Remaining running-workload evidence: `⟨fill at activation⟩`.

**Source-access amendment, 2026-09-23T03:36Z.** Under the existing consumer exception,
the installed Kalshi helper recorded and applied 33 ACL records: 32 access records and
one log-directory default. Both `obiexec` and `aurascoper` now read the pinned source
and shadow log and stat the producer configuration; neither can read the producer's
private env file. Both bonzos and aurascoper remain denied the production credential
directory. All after-ACLs matched at 03:36:54Z. Original, renamed and replacement
temporary owner-created log files were readable by both consumers and then removed.
The actual producer log was not rotated; its rotation remains unobserved.

Both consumers obtained source pin
`def8805af6194a5da5b19fa08bcc573b2ad73a972a8b0c247d49ab352b6764a9`.
Producer HEAD remains `532ff06332998f0f335f76ec450ef07b3b1930a9`; worker PID/start ticks
are `2228/2919` and `2263/3086`. No source code, environment, gate or process changed.
No source-availability endpoint or durable attestation was created. Production entry
stays inactive/masked, recovery inactive; no journal, arming or pilot service start.
Installed artifact and execution hash remain the values above; the next reviewed
release must carry forward the permission undo records.

The standard W2 readback passed at 03:37:12Z: collector/shadow ages 2 s/12 s, current-hour
files, zero worker order gates, no calibration, 58.4 °C and `throttled=0x0`.
Load snapshots before/after were 1.01/0.96/0.94 and 1.03/0.97/0.94; access verification
took 1.644 seconds. These observations do not establish credentialed consumer load.
Exact ACLs/readback are in obi `docs/pilot/KALSHI_SOURCE_ACCESS_RECEIPT.json`.
Undo is `sudo python3 /opt/obi-kalshi/recovery/scripts/kalshi_host.py rollback --restore-permissions`;
it restores only ACLs still matching their recorded after-state and retains state and
compatible recovery. Credentialed load, alerts and truthful source availability remain open.

**Disarmed upgrade, 2026-09-23T04:00:50Z.** Commit
`ef21a331f8b88b6f229e61ff183ba0fac1d9aa92` replaces the initial executable with artifact
`2b5433b00a18f61a1495be52b6a0a130a4e2c60786da01cebbed234a2eb06dd9` and Pi execution hash
`09a194f9a4b0e361f8cfc2c420e8b8cfb108ab76a13d8c469aa5d445e1293b31`.
All 17 installed runtime-file hashes match the commit; the seal and unit bytes match.
`current`, compatible schema-2 `recovery`, and the inactive demo code link point to the
new immutable artifact. Earlier artifacts remain. The 33 ACL undo records and both
private configurations remain unchanged. The existing empty kill marker is retained,
with its recorded owner correction from root to obiexec. Entry stays inactive/masked;
recovery and demo stay inactive. No Pi credential, journal, arming, attestation or
service start was introduced; no venue request occurred on this host.

Owner-side source checks now also bind the workers' actual cwd and output directory:
same PIDs/start ticks and source pin, cwd `/home/bonzos/brti-edge/apps/market-worker`,
log directory device/inode `45826/2445553`. These checks make no source-availability
promise. The W2 readback passed at 04:02:35Z, with source processes unchanged,
collector/shadow ages 0 s/5 s, current-hour files, zero gates, no calibration,
57.4 °C and `throttled=0x0`. Clock synchronization passed.

Upgrade elapsed time was 18.524 seconds. Before/after load snapshots were
0.69/1.00/1.11 and 1.24/1.12/1.13. Retained artifacts/stages grew from 53144 to
84252 KiB; the post-install snapshot had 170825859072 bytes and 14521807 inodes free.
These are installation observations, not a credentialed consumer load check.
Receipt: obi `docs/pilot/KALSHI_UPGRADE_RECEIPT.json`. Exact undo remains the pinned
`kalshi_host.py rollback --restore-permissions` command above; current state is never
replaced with an earlier journal. Running-consumer availability, actual rotation,
credentialed load/API rate and alert evidence remain open.

**Finalized-market mapping upgrade, 2026-09-23T05:00:28Z.** The covered disarmed
consumer update installs commit `d485589bae7a753d400da64c284bbcefed1cea7a`, source
artifact `554a38ee02ea4731d44a00d7f94686adc9d33d950762cd5efe86bb1651c65b25`, and Pi
execution hash `b72152e3f7e748be31cde61ce13006f03dacc704569644035e6cf0dab50a6472`.
Its only runtime change from the preceding release is settlement finalized-status
mapping and ticker validation. All 17 installed runtime-file hashes match the commit;
the full seal matches. Current/recovery/demo code links point to that root-owned
artifact; earlier artifacts remain. Both configurations and all 33 ACL undo records
are unchanged, with live ACLs matching their after-state. The kill marker and entry
mask remain; no new source permission, credential, journal, attestation or service
start was introduced.

The current static recovery unit has no dependency on masked entry. Its GET-only
transport rejected write methods before transmission in an installed-code probe.
Actual authenticated Pi recovery remains unverified because no bound journal or
production credentials exist. Source pins, process IDs, cwd and output identity
remain unchanged. No availability promise was invented.

The W2 readback passed at 05:01:58Z: collector/shadow ages 1 s/13 s, current-hour files,
zero worker order gates, no calibration, 60.3 °C and `throttled=0x0`; NTP synchronized.
The upgrade took 18.311 seconds. Load snapshots before/after were 0.94/0.98/0.99 and
1.11/0.94/0.97. Retained artifact/stage footprint is 115364 KiB (previously 84252 KiB);
170710532096 bytes and 14520440 inodes remained free. These are installation snapshots,
not credentialed operating-load measurements. Evidence is in obi
`docs/pilot/KALSHI_FINALIZED_UPGRADE_RECEIPT.json`; historical receipts remain intact.
Undo remains the pinned `kalshi_host.py rollback` command; use `--restore-permissions`
only for recorded ACL restoration. Keep current journals and compatible recovery.

**Bounded credentialed reads, 2026-09-23T05:56Z.** Under the retained disarmed
verification authority, the installed `d485589b` Kalshi application ran one GET-only
process as obiexec. It made 25 requests (15 signed, 10 public) in 3.899475 seconds;
user/system CPU time was 1.200218/0.075602 seconds and peak RSS 47336 KiB. The short
burst averaged 6.41112 requests/second. Work was bounded by 64 attempts, a 45-second
admission deadline and five-second request timeouts. This observation does not
establish steady-state consumer load or live execution acceptance.

NTP remained synchronized. Before/after host snapshots showed source ages
4.504 s/1.241 s and load 1.06/1.24/1.18 → 0.79/1.13/1.15. Disk/inodes were
170625630208 bytes/14520438 → 170623311872 bytes/14520437. A redacted host receipt was
added; no source files, permissions, configuration, producer process or order gate
changed. The standard readback passed at 05:58:01Z: collector/shadow ages 1 s/0 s,
same worker PIDs, zero gates, no calibration, 58.9 °C and `throttled=0x0`.

The dedicated credential files were already present before the process, private
to obiexec; D1 access probes denied both bonzos and aurascoper. Entry remains
inactive/masked and recovery inactive/static. No order, allocation, journal,
arming or service start occurred. Account/subaccount confirmation is still open;
historical settlement normalization refused mixed YES/NO history without adopting
it. Alert delivery remains untested because the destination is a placeholder.
Evidence: obi `docs/pilot/KALSHI_CREDENTIALED_READ_HOST_RECEIPT.json`. The process has
exited, so there is no running workload to undo; retain its evidence. Source
availability/attestation and a credentialed steady-state consumer check remain open.

**Settlement scope upgrade, 2026-09-23T06:08:56Z.** The retained disarmed-install
authorization covers exact commit `2b0a748e4524d034f0c853ab5df2a50422a4a875`.
Its recovery path selects journal-owned settlement tickers before normalizing
unrelated account history. The 17 committed runtime files and two examples were
staged without credentials. Source artifact
`9682bb2255ed8c3e87475c999a21e51aef2a872de1b6e79bea3a4b34cbd9a8a2` and Pi execution
hash `b920da23ab12e9fa1e2535ec04c06393b1180ee6ac1f7fcf36480766485291a2` match the
installed bytes. Current/recovery/demo code links point to this artifact.

Entry stays inactive/masked; recovery inactive/static. The installed GET-only
guard rejected four write methods without a request opener, credential or journal.
Both configuration contents, credential metadata, state files and all 33 ACL undo
records were retained. D1 remains enforced. No journal, arming, service start,
venue request, allocation, source change or permission change occurred.

Upgrade time was 19.623 s. Before/after load was 1.44/1.26/1.15 → 1.64/1.34/1.18;
retained artifacts/stages grew 115364 → 146476 KiB. Available disk/inodes changed
170611621888 bytes/14520432 → 170578124800 bytes/14519071. NTP stayed synchronized.
The standard readback passed at 06:09:08Z: same source PIDs, collector/shadow ages
1 s/7 s, current-hour files, zero gates, no calibration, 58.9 °C, `throttled=0x0`.
These observations measure installation, not steady-state consumer operation.

Evidence: obi `docs/pilot/KALSHI_SETTLEMENT_SCOPE_UPGRADE_RECEIPT.json`.
Undo remains `sudo python3 /opt/obi-kalshi/recovery/scripts/kalshi_host.py rollback`;
append `--restore-permissions` only for recorded ACL restoration. Keep current
state and compatible recovery. Prior authenticated evidence remains pinned to
its prior release; this upgrade did not re-run venue checks or adopt history.

**Canonical mapping and bounded reads, 2026-09-23T06:39–06:49Z.** The coordinator's
GET-only diagnostic on `2b0a748e` made 37 requests in 4.820459 s, peak RSS 45024 KiB,
process CPU 1.43423 s. All 12 selected existing orders had stable canonical fields
and exact fill totals; five unrelated historical ticker rows were kept separate.
Load was 0.94/0.95/0.92 → 1.03/0.97/0.93; source age 2.383 s → 7.182 s; NTP stayed
synchronized. No order, journal or service was created by this diagnostic.

Under the retained disarmed-install authorization, commit
`05afd782724bc25fc74d692dca7b0655c5411c5c` was installed at 06:46:25Z. Source artifact
`734839d28e5374e4024d91f5137f08cec462b41f1118398225d33f2480db12f1` and Pi execution
hash `23c3994fa02c58f65d0cefeaa97a190fd667a09f9f77fd7d21dec8d1ea5f0564` match the
17 committed runtime files and recomputed seal. Config contents, credential metadata,
state and all 33 ACL undo records were retained. Entry stays masked/inactive;
recovery stays inactive with no entry dependency and its GET-only guard intact.

Upgrade time was 19.558 s; load 0.75/0.92/0.97 → 1.13/0.98/0.98; retained artifacts
and stages 146476 → 177588 KiB. Available disk/inodes changed 170522619904
bytes/14519070 → 170487144448 bytes/14517709. No producer/source change or new
permission occurred; both consumers retain source read access and the same pin.

At 06:48:55Z, one existing order with a unique client reference passed the installed
adapter lookup with exact fills, principal and fees. The external capture helper
made six GETs in 1.358660 s, peak RSS 46860 KiB, user/system CPU 0.498348/0.026482 s;
it allows at most 40 attempts, 45 s admission time and five-second request timeouts.
Other selected old orders have empty references and remain unverified for lookup.
No reference was fabricated, no history adopted and no signal admitted.

The W2 readback passed at 06:49:02Z: same PIDs, collector/shadow ages 1 s/1 s,
current-hour files, zero gates, no calibration, 57.9 °C and `throttled=0x0`.
NTP stayed synchronized. No pilot service, journal, arming, allocation or order
write occurred. Evidence: obi `docs/pilot/KALSHI_CANONICAL_UPGRADE_RECEIPT.json`
and `docs/pilot/fixtures/kalshi-production-adapter-readback-20260923.json`.
These bounded checks do not establish steady-state consumer load or a new pilot
execution. Account confirmation, source availability and alerts remain open.
Undo is the pinned `kalshi_host.py rollback`; retain compatible recovery/current
state and use `--restore-permissions` only for recorded ACL restoration.

Rollback persists entry disarming, quarantines arming, masks entry across reboot and keeps
a schema-compatible GET-only recovery executable and the current journal. Never restore
an older journal snapshot or run the old executable without established schema
compatibility. Exact receipt and commands are in obi `docs/pilot/KALSHI_HOST_RECEIPT.md`
and `KALSHI_OPERATIONS.md`; per-path ACL undo records are required before permissions change.

The operator keeps the full host change log, each change with its undo, for the restore
after the close.

**Economic declaration.** obi commit `⟨fill at lock⟩`, GitHub release `⟨fill at lock⟩`,
declares the holdout window `w2pp-holdout-20260924` and the economic design before
10:00Z.

**Lock authority.** `⟨fill at lock: the operator's words and time⟩`.
