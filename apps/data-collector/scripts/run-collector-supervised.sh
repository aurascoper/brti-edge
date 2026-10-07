#!/usr/bin/env bash
# =============================================================================
# Kalshi data-collector — drain-safe supervised launcher
# =============================================================================
# Supplies the missing half of the shutdown contract documented in
# src/index.ts:412 ("the wrapper script's SIGKILL fires at +5s as final
# backstop") and adds the three things that actually drive holdout coverage:
#
#   1. SLEEP PREVENTION  — caffeinate holds display/idle/disk/system assertions
#                          for the supervisor's lifetime (the 15h + 3h gaps we
#                          measured were laptop sleep).
#   2. CRASH RESTART     — relaunch on exit, with exponential backoff so a
#                          crash-loop can't hammer the API.
#   3. STALL WATCHDOG    — if no orderbook-deltas file has been written for
#                          STALE_SECONDS (default 300s; the collector flushes
#                          every 5s during active markets), the socket is dead
#                          but the process is wedged — drain-restart it.
#
# DRAIN SAFETY: on every stop we send SIGTERM and grant GRACE_SECONDS (default
# 5s > the collector's 3s-per-rotator closeAsync timeout) for the gzip CRC32+
# size trailer to land, THEN SIGKILL. This is what prevents the `.drainbug`
# corruption that quarantined the 2026-05-25T06 hour.
#
# Run directly (simple, e.g. inside tmux):   bash scripts/run-collector-supervised.sh
# Or under launchd (boot/sleep-wake survival): see com.polyterminal.kalshi-collector.plist
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
LOG_DIR="${DATA_COLLECTOR_LOG_DIR:-$APP_DIR/logs/data-collector}"
STATE_DIR="$APP_DIR/ops/state"
STATUS="$STATE_DIR/collector-supervisor.jsonl"
mkdir -p "$LOG_DIR" "$STATE_DIR"

# ---- tunables (all overridable via env) ----
GRACE_SECONDS="${COLLECTOR_GRACE_SECONDS:-5}"     # SIGTERM -> wait -> SIGKILL
STALE_SECONDS="${COLLECTOR_STALE_SECONDS:-300}"   # no deltas write => stall
WATCH_INTERVAL="${COLLECTOR_WATCH_INTERVAL:-30}"  # health-check cadence
MIN_UP_SECONDS="${COLLECTOR_MIN_UP_SECONDS:-30}"  # shorter life => back off
MAX_BACKOFF="${COLLECTOR_MAX_BACKOFF:-60}"

STOPPING=false
CHILD_PID=""
CAFFEINATE_PID=""
RESTARTS=0

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Interruptible sleep: a FOREGROUND `sleep` defers trapped signals until it
# finishes (so SIGTERM could take WATCH_INTERVAL seconds to honor — longer than
# launchd's ExitTimeOut, which would SIGKILL us mid-drain and orphan the
# collector). Backgrounding + `wait` lets on_signal run within ~0s of SIGTERM.
nap() { sleep "$1" & wait "$!" 2>/dev/null; }

# Cap the launchd StandardErrorPath log (gzip-backpressure warns flood it —
# 77MB observed 2026-08-15). launchd holds the fd open, so truncate via
# cat-copy-back to preserve the inode — tail|mv would orphan the fd and the
# file would keep growing invisibly. Checked each health tick; fires >1MB.
#
# 2026-10-06: this silently failed for ~2 months and reached 8.7GB, filling the
# Pi's root fs and ending the W2'' window. Two defects, both fixed here:
#   1. The log was root-owned 0644 while the supervisor runs unprivileged, so the
#      cat-copy-back got EACCES every tick, left an orphaned .captmp, and never
#      capped. A failure that repeats every 30s must be REPORTED, not retried in
#      silence — so writability is now pre-checked and announced once.
#   2. The staging temp was written next to the log, i.e. INTO the filesystem the
#      cap exists to relieve. On a full disk the cap was guaranteed to fail at
#      exactly the moment it was needed. It now stages on tmpfs.
# `tail -n` seeks from the end (measured: 0.01s on the 8.7GB file), so this is
# cheap even when badly overgrown. The size probe's `-f%z` exits non-zero on GNU
# stat, so the `-c%s` fallback is reached — unlike the `-f %m` form, see
# newest_delta_mtime.
ERR_LOG="$STATE_DIR/launchd-collector.err.log"
CAP_BLOCKED_ANNOUNCED=false
CAP_TMPDIR="${COLLECTOR_CAP_TMPDIR:-}"
if [ -z "$CAP_TMPDIR" ]; then
  for d in /dev/shm /run/shm "${TMPDIR:-/tmp}"; do
    [ -d "$d" ] && [ -w "$d" ] && { CAP_TMPDIR="$d"; break; }
  done
fi

cap_err_log() {
  [ -f "$ERR_LOG" ] || return 0
  [ "$(stat -f%z "$ERR_LOG" 2>/dev/null || stat -c%s "$ERR_LOG" 2>/dev/null || echo 0)" -gt 1048576 ] || return 0

  # Fail loud, once. Without this the cap can be broken indefinitely in silence.
  if [ ! -w "$ERR_LOG" ]; then
    if ! $CAP_BLOCKED_ANNOUNCED; then
      log_event errlog_cap_blocked "not writable by $(id -un): $ERR_LOG — it will grow unbounded until ownership is fixed"
      CAP_BLOCKED_ANNOUNCED=true
    fi
    rm -f "$ERR_LOG.captmp"   # clear any orphan left by the old copy-back
    return 1
  fi

  local tmp
  tmp="$(mktemp "${CAP_TMPDIR:-/tmp}/errlogcap.XXXXXX" 2>/dev/null)" || return 1
  if tail -n 5000 "$ERR_LOG" > "$tmp" 2>/dev/null && cat "$tmp" > "$ERR_LOG" 2>/dev/null; then
    rm -f "$tmp"
    $CAP_BLOCKED_ANNOUNCED && { log_event errlog_cap_recovered "cap is working again"; CAP_BLOCKED_ANNOUNCED=false; }
    return 0
  fi
  rm -f "$tmp"
  return 1
}

log_event() {
  local ev="$1" reason="${2:-}" ts; ts="$(now_iso)"
  printf '{"ts":"%s","event":"%s","reason":"%s","child_pid":%s,"restarts":%s}\n' \
    "$ts" "$ev" "$reason" "${CHILD_PID:-null}" "$RESTARTS" >> "$STATUS"
  echo "[$ts] supervisor: $ev${reason:+ — $reason}"
}

# Safe .env loader: simple KEY=VALUE lines only, no eval/command-substitution.
load_env() {
  local f="$1" line key val
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#export }"
    case "$line" in ''|\#*) continue ;; *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < "$f"
}
load_env "$ROOT_DIR/.env"
load_env "$APP_DIR/.env"

# Kalshi creds: the collector self-loads KALSHI_* from live_trading/.env via its
# loadEnvFromLiveTrading() (src/index.ts), so they need not be in our shell env.
LIVE_TRADING_ENV="${KALSHI_LIVE_TRADING_ENV:-/Users/aurascoper/Developer/live_trading/.env}"
if [ -z "${KALSHI_API_KEY_ID:-}" ]; then
  if [ -f "$LIVE_TRADING_ENV" ] && grep -q '^KALSHI_API_KEY_ID=' "$LIVE_TRADING_ENV" 2>/dev/null; then
    log_event creds "collector will self-load KALSHI_* from $LIVE_TRADING_ENV"
  else
    log_event warn "KALSHI_API_KEY_ID unset and $LIVE_TRADING_ENV missing — auth will fail"
  fi
fi

# Resolve the collector entrypoint as a DIRECT child so SIGTERM reaches it.
if [ -x "$APP_DIR/node_modules/.bin/tsx" ]; then
  RUN=("$APP_DIR/node_modules/.bin/tsx" "src/index.ts")
else
  RUN=(pnpm exec tsx src/index.ts)
fi

newest_delta_mtime() {
  local newest=0 m f
  for f in "$LOG_DIR"/orderbook-deltas-*.jsonl.gz; do
    [ -e "$f" ] || continue
    # BSD stat (macOS) first, GNU stat (Linux) fallback — without the
    # fallback the watchdog silently never fires on Linux.
    m="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)" || continue
    [ "$m" -gt "$newest" ] && newest="$m"
  done
  echo "$newest"
}

stop_child() {
  local pid="$1" i=0
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge "$GRACE_SECONDS" ]; then
      log_event sigkill "child $pid did not drain within ${GRACE_SECONDS}s"
      kill -KILL "$pid" 2>/dev/null
      break
    fi
    sleep 1
  done
}

on_signal() {
  $STOPPING && return
  STOPPING=true
  log_event supervisor_stop "signal received — draining child"
  stop_child "$CHILD_PID"
  [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null
  exit 0
}
trap on_signal TERM INT

# Testability seam. With COLLECTOR_LIB_ONLY=1 the script defines its functions and
# stops here, so cap_err_log and newest_delta_mtime can be exercised directly
# without supervising a child. Everything above is definitions plus the mkdir of
# LOG_DIR/STATE_DIR, both of which a test points at a scratch directory.
# Added because the two defects fixed on 2026-10-06 were each invisible to every
# check that existed, and an untestable health control is how that happens.
if [ "${COLLECTOR_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# Hold sleep assertions for the supervisor's lifetime (-w waits on our PID).
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsw "$$" &
  CAFFEINATE_PID="$!"
  log_event caffeinate "holding display/idle/disk/system assertions (pid $CAFFEINATE_PID)"
else
  log_event warn "caffeinate not found — system sleep can still cause coverage gaps"
fi

log_event supervisor_start "log_dir=$LOG_DIR grace=${GRACE_SECONDS}s stale=${STALE_SECONDS}s"

backoff=1
while true; do
  start_ts="$(date +%s)"
  ( cd "$APP_DIR" && exec "${RUN[@]}" ) &
  CHILD_PID="$!"
  log_event start "collector pid $CHILD_PID"

  # inner health-watch loop
  while kill -0 "$CHILD_PID" 2>/dev/null; do
    nap "$WATCH_INTERVAL"
    $STOPPING && break
    cap_err_log
    mt="$(newest_delta_mtime)"
    if [ "$mt" -gt 0 ]; then
      age=$(( $(date +%s) - mt ))
      if [ "$age" -gt "$STALE_SECONDS" ]; then
        log_event stale_restart "no orderbook-deltas write in ${age}s (>${STALE_SECONDS}s)"
        stop_child "$CHILD_PID"
        break
      fi
    fi
  done

  wait "$CHILD_PID" 2>/dev/null; rc=$?
  up=$(( $(date +%s) - start_ts ))
  $STOPPING && break
  RESTARTS=$(( RESTARTS + 1 ))
  log_event child_exit "rc=$rc uptime_s=$up"

  if [ "$up" -lt "$MIN_UP_SECONDS" ]; then
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff="$MAX_BACKOFF"
  else
    backoff=1
  fi
  log_event backoff "restarting in ${backoff}s"
  nap "$backoff"
done
