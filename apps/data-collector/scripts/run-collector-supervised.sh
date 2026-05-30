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
    m="$(stat -f %m "$f" 2>/dev/null)" || continue
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
