#!/usr/bin/env bash
# =============================================================================
# Polymarket collector readiness gate — is the last 24h of archive coverage OK?
# =============================================================================
# Adaptation of collector-readiness-check.sh for the Polymarket archiver.
# The Kalshi gate wraps adequacyReport.ts; the pm channels have no TS reporter
# yet, so this gate scans the gzip archive directly with inline python3.
#
# Checks over the trailing 24 fully-elapsed UTC hours:
#   1. dense channels (pm-book, pm-price-change, pm-last-trade, spot-trades)
#      have a file for EVERY hour; sparse event-driven channels (pm-tick-size,
#      pm-markets — files are created lazily on first write, and tick_size_change
#      only fires when a book crosses the 0.96/0.04 boundary) need at least one
#      file somewhere in the window
#   2. no coverage gap > 1h in pm-book row timestamps (the current in-progress
#      hour's partial files are included, so rows the elapsed-hours scan cannot
#      see don't inflate the trailing gap)
#   3. all three assets (PM_COLLECTOR_ASSETS, default btc,eth,sol) seen in the
#      'asset' field of parsed pm-markets rows
#
#   exit 0  => READY
#   exit 1  => NOT-READY (or no data)
#
# Usage:
#   bash scripts/polymarket-readiness-check.sh
#   PM_READINESS_HOURS=6 bash scripts/polymarket-readiness-check.sh   # shorter window
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="${PM_COLLECTOR_LOG_DIR:-$APP_DIR/logs/polymarket}"
HOURS="${PM_READINESS_HOURS:-24}"
ASSETS="${PM_COLLECTOR_ASSETS:-btc,eth,sol}"

python3 - "$LOG_DIR" "$HOURS" "$ASSETS" <<'PY'
import glob, gzip, json, os, sys
from datetime import datetime, timedelta, timezone

log_dir, hours, assets = sys.argv[1], int(sys.argv[2]), [a for a in sys.argv[3].lower().split(",") if a]
DENSE_CHANNELS = ["pm-book", "pm-price-change", "pm-last-trade", "spot-trades"]
SPARSE_CHANNELS = ["pm-tick-size", "pm-markets"]
MAX_GAP_S = 3600.0

now = datetime.now(timezone.utc)
end_hour = now.replace(minute=0, second=0, microsecond=0)
hour_keys = [(end_hour - timedelta(hours=h)).strftime("%Y-%m-%dT%H") for h in range(hours, 0, -1)]
window_start = (end_hour - timedelta(hours=hours)).timestamp()
failures = []

print(f"window:          {hour_keys[0]}Z .. {hour_keys[-1]}Z ({hours}h)  dir={log_dir}")

# --- check 1: dense channels every hour, sparse channels window-level ----
# pm-tick-size / pm-markets are event-driven and lazily created, so a healthy
# collector legitimately has hours with no file; requiring them per-hour makes
# the gate permanently red. Gate them on window-level existence instead.
missing = []
for ch in DENSE_CHANNELS:
    have = 0
    for hk in hour_keys:
        if glob.glob(os.path.join(log_dir, f"{ch}-{hk}*.jsonl.gz")):
            have += 1
        else:
            missing.append(f"{ch}@{hk}")
    print(f"channel {ch:16s} {have}/{hours} hours")
if missing:
    head = ", ".join(missing[:8]) + (" …" if len(missing) > 8 else "")
    failures.append(f"{len(missing)} missing (channel,hour) files: {head}")
for ch in SPARSE_CHANNELS:
    have = sum(1 for hk in hour_keys if glob.glob(os.path.join(log_dir, f"{ch}-{hk}*.jsonl.gz")))
    print(f"channel {ch:16s} {have}/{hours} hours (sparse: window-level gate)")
    if have == 0:
        failures.append(f"sparse channel {ch}: no file anywhere in window")

def row_ts(line):
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        return None
    ts = row.get("ingest_ts", row.get("src_ts"))
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return None
    return ts / 1000.0 if ts > 1e11 else ts  # epoch-ms vs epoch-s

def first_last_ts(path):
    first = last = None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                ts = row_ts(line)
                if ts is None:
                    continue
                if first is None:
                    first = ts
                last = ts
    except (OSError, EOFError):
        pass  # truncated in-progress gzip: keep what we decoded
    return first, last

# --- check 2: no gap > 1h in pm-book coverage ----------------------------
# The trailing gap is measured against now, so the current in-progress hour's
# partial files must be scanned too (first_last_ts tolerates truncated gzip) —
# otherwise rows since the top of the hour are invisible and a healthy
# collector fails on a stale-looking trailing gap.
spans = []
for hk in hour_keys + [end_hour.strftime("%Y-%m-%dT%H")]:
    for path in sorted(glob.glob(os.path.join(log_dir, f"pm-book-{hk}*.jsonl.gz"))):
        f, l = first_last_ts(path)
        if f is not None:
            spans.append((f, l))
spans.sort()
if not spans:
    failures.append("no readable pm-book rows in window")
    print("pm-book gap:     n/a (no rows)")
else:
    worst = max(0.0, spans[0][0] - window_start)  # lead-in gap counts too
    cursor = spans[0][1]
    for f, l in spans[1:]:
        if f > cursor:
            worst = max(worst, f - cursor)
        cursor = max(cursor, l)
    worst = max(worst, now.timestamp() - cursor)
    print(f"pm-book gap:     longest {worst/60.0:.1f} min (limit 60.0)")
    if worst > MAX_GAP_S:
        failures.append(f"pm-book gap {worst/60.0:.1f} min > 60 min")

# --- check 3: all assets seen in pm-markets ------------------------------
unseen = set(assets)
for hk in reversed(hour_keys):  # newest first — usually terminates on file 1
    if not unseen:
        break
    for path in glob.glob(os.path.join(log_dir, f"pm-markets-{hk}*.jsonl.gz")):
        if not unseen:
            break
        try:
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                # Parse each row and compare its 'asset' field — substring
                # matching on the raw line false-PASSes ('sol' is inside
                # 'resolution', 'eth' inside 'whether').
                for line in fh:
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    a = row.get("asset")
                    if isinstance(a, str):
                        unseen.discard(a.lower())
                    if not unseen:
                        break
        except (OSError, EOFError):
            pass
seen = [a for a in assets if a not in unseen]
print(f"assets seen:     {','.join(seen) if seen else '(none)'} of {','.join(assets)}")
if unseen:
    failures.append(f"assets never seen in pm-markets: {','.join(sorted(unseen))}")

print("----------------------------------------------------------------------")
if failures:
    print("⛔ NOT-READY")
    for f in failures:
        print(f"   - {f}")
    sys.exit(1)
print("✅ READY — dense channels hourly, sparse channels in window, pm-book gap ≤1h, all assets seen")
sys.exit(0)
PY
