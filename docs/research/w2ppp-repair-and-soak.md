# W2 triple-prime instrument and pre-lock soak

This prospective repair starts from the deployed W2 double-prime revision
`ea4a3f871a1b7550a1ef1661596b0be6e6b62349`. It preserves the October 8 close:
NO-GO(data), 81.87% shadow coverage, 83.43% worst collector hour coverage,
240 missing settlements. The previously recorded SSD mount during that window
also remains a host-integrity finding. Neither result is repaired retroactively.

The reused fixes establish that GNU `stat -f %m` returned nonnumeric filesystem
text with exit zero, empty hour files masked stalls, and ENOSPC exited zero.
The legacy root-owned error log could not be capped. The later repair notes
date a lifecycle ENOSPC to October 3, earlier than the rsyslog evidence used
in the first postmortem. The old postmortem and raw close artifacts remain
historical records; this note does not replace them.

The instrument uses `/mnt/ssd/kalshi/w2ppp/data-collector`. Collector,
watchdog, health probe and mechanical close wrapper bind that resolved path.
Historical archives remain separate. The Pi collector writes stdout/stderr to
the `brti-edge` journal namespace (64 MiB persistent, 16 MiB runtime).
Backpressure warnings are limited to one per channel per 30 seconds. File,
compressor and trailer errors are fatal. Persistence checks never copy logs.
The 300-second watchdog wakes at its deadline and at most every 30 seconds;
the five-second drain and relaunch fit inside the 330-second acceptance bound.

The root-owned controller records one soak from its first full UTC hour,
restarts collection after the first completed hour, and waits for 30 full hours
plus five minutes for settlement observation. It requires synchronized time,
the same boot and SSD identity, a masked and inactive entry pilot, frozen code,
unchanged worker gates and feeds, >=99% worst-channel coverage, <=1 hour gap,
all settled markets reconciled, and readable, nonempty, complete gzip segments
across 30 hours in both book channels. These gzip checks are additional pre-lock
instrument checks, not a change to the published holdout scoring rules.

Only a passing soak commits the lock before the next UTC-hour boundary and
schedules day-seven and day-fourteen reports through `w2_close_check.py`.
G1-G7 thresholds, published pause exclusions, signal code and scorer stay
unchanged. Failure records are terminal, and restarts never select another
window. Every failed window retains its receipt. The controller remains active
through the holdout and retains any host-integrity violation.

Only the full fourteen-day eligible, frozen close can create `stage-a-go.json`.
An interim GO cannot activate Stage B. The independent Python pilot additionally
requires that GO receipt when creating a live round and binds its SHA-256 into
the journal. Changing the GO or signal source blocks new entries; GET-only
recovery does not depend on research, source, arming or entry availability.
No controller starts the production pilot, moves funds, or starts its clock.

After a valid GO, renew the producer attestation for the actual 48-hour round
and refresh authenticated account/subaccount, inventory, market exchange-shard
balance, fee schedule and settlement-rule observations. Hunter starts the clock
through activation and approves the first five exact fresh tickets. Synthetic
tests and disarmed observations do not establish venue execution acceptance.

The historical demo reference `63707dfd-b1ff-5ff6-9037-8c18c40487ff` stays
unknown and unretried, with its original journal/reservation preserved on its
original host. `1705bonzos` is producer and eventual executor; `pi-comp` is
not an execution dependency.
