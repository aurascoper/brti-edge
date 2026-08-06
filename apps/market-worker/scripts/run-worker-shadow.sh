#!/usr/bin/env bash
# =============================================================================
# Kalshi scan worker — shadow-only supervised launcher
# =============================================================================
# Sibling of apps/data-collector/scripts/run-collector-supervised.sh, adapted
# for the scan worker (src/kalshi/worker.ts). Recreated 2026-08-01: the
# original died with the pre-rename polyterminal checkout, leaving
# com.polyterminal.kalshi-worker exiting 127 since the repo move.
#
# What it adds over bare `pnpm kalshi-scan`:
#
#   1. ORDER GATES PINNED — KALSHI_ALLOW_ORDERS / KALSHI_AUTO_SUBMIT /
#                           KALSHI_DUST_ENABLED are forced to 0 AFTER .env
#                           loading, so no .env edit can arm order submission
#                           through this launcher. Live trading = a separate
#                           R7 prereg, not an edit to this file.
#   2. CRASH RESTART      — relaunch on exit, exponential backoff on rapid
#                           failure so a crash-loop can't hammer the API.
#   3. STALL WATCHDOG     — the worker appends every shadow fire (incl. SKIPs)
#                           to logs/kalshi-shadow.jsonl on each scan tick
#                           (default 15s). If neither shadow nor candidates
#                           log has been written for STALE_SECONDS, the feed
#                           is dead but the process is wedged — restart it.
#
# NOT here on purpose:
#   - caffeinate: the collector agent already holds wake assertions for the
#     holdout window (see com.polyterminal.kalshi-worker.plist header).
#   - long drain grace: the worker writes no gzip trailer; 5s SIGTERM->SIGKILL
#     is plenty (plist ExitTimeOut is 10s).
#
# Run directly:   bash scripts/run-worker-shadow.sh
# Under launchd:  see scripts/com.polyterminal.kalshi-worker.plist
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
LOG_DIR="$APP_DIR/logs"
STATE_DIR="$APP_DIR/ops/state"
STATUS="$STATE_DIR/worker-supervisor.jsonl"
mkdir -p "$LOG_DIR" "$STATE_DIR"

# ---- tunables (all overridable via env) ----
GRACE_SECONDS="${WORKER_GRACE_SECONDS:-5}"     # SIGTERM -> wait -> SIGKILL
STALE_SECONDS="${WORKER_STALE_SECONDS:-300}"   # no shadow/candidate write => stall (20 scan ticks)
WATCH_INTERVAL="${WORKER_WATCH_INTERVAL:-30}"  # health-check cadence
MIN_UP_SECONDS="${WORKER_MIN_UP_SECONDS:-30}"  # shorter life => back off
MAX_BACKOFF="${WORKER_MAX_BACKOFF:-60}"
PORT="${KALSHI_WORKER_PORT:-4001}"

STOPPING=false
CHILD_PID=""
RESTARTS=0

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Interruptible sleep: a FOREGROUND `sleep` defers trapped signals until it
# finishes; backgrounding + `wait` lets on_signal run within ~0s of SIGTERM.
nap() { sleep "$1" & wait "$!" 2>/dev/null; }

log_event() {
  local ev="$1" reason="${2:-}" ts; ts="$(now_iso)"
  printf '{"ts":"%s","event":"%s","reason":"%s","child_pid":%s,"restarts":%s}\n' \
    "$ts" "$ev" "$reason" "${CHILD_PID:-null}" "$RESTARTS" >> "$STATUS"
  echo "[$ts] worker-supervisor: $ev${reason:+ — $reason}"
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

# Shadow-only kill switches — pinned AFTER load_env so nothing can flip them.
export KALSHI_ALLOW_ORDERS=0
export KALSHI_AUTO_SUBMIT=0
export KALSHI_DUST_ENABLED=0

# Kalshi creds: worker.ts self-loads KALSHI_* from live_trading/.env via
# loadEnvFromLiveTrading(); they need not be in our shell env.
LIVE_TRADING_ENV="${KALSHI_LIVE_TRADING_ENV:-/Users/aurascoper/Developer/live_trading/.env}"
if [ -z "${KALSHI_API_KEY_ID:-}" ]; then
  if [ -f "$LIVE_TRADING_ENV" ] && grep -q '^KALSHI_API_KEY_ID=' "$LIVE_TRADING_ENV" 2>/dev/null; then
    log_event creds "worker will self-load KALSHI_* from $LIVE_TRADING_ENV"
  else
    log_event warn "KALSHI_API_KEY_ID unset and $LIVE_TRADING_ENV missing — auth will fail"
  fi
fi

# Port preflight: a manual `pnpm kalshi-dev` holding :4001 would otherwise
# EADDRINUSE-crash-loop us (throttled to one relaunch / 30s by the plist).
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log_event port_busy ":$PORT already has a listener — stop the manual worker first"
  exit 1
fi

# Resolve the worker entrypoint as a DIRECT child so SIGTERM reaches it.
if [ -x "$APP_DIR/node_modules/.bin/tsx" ]; then
  RUN=("$APP_DIR/node_modules/.bin/tsx" "src/kalshi/worker.ts")
else
  RUN=(pnpm exec tsx src/kalshi/worker.ts)
fi

newest_output_mtime() {
  local newest=0 m f
  for f in "$LOG_DIR/kalshi-shadow.jsonl" "$LOG_DIR/kalshi-candidates.jsonl"; do
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
      log_event sigkill "child $pid did not exit within ${GRACE_SECONDS}s"
      kill -KILL "$pid" 2>/dev/null
      break
    fi
    sleep 1
  done
}

on_signal() {
  $STOPPING && return
  STOPPING=true
  log_event supervisor_stop "signal received — stopping child"
  stop_child "$CHILD_PID"
  exit 0
}
trap on_signal TERM INT

log_event supervisor_start "gates=0/0/0 port=$PORT stale=${STALE_SECONDS}s"

backoff=1
while true; do
  start_ts="$(date +%s)"
  ( cd "$APP_DIR" && exec "${RUN[@]}" ) &
  CHILD_PID="$!"
  log_event start "worker pid $CHILD_PID (shadow-only)"

  # inner health-watch loop
  while kill -0 "$CHILD_PID" 2>/dev/null; do
    nap "$WATCH_INTERVAL"
    $STOPPING && break
    mt="$(newest_output_mtime)"
    if [ "$mt" -gt 0 ]; then
      age=$(( $(date +%s) - mt ))
      if [ "$age" -gt "$STALE_SECONDS" ]; then
        log_event stale_restart "no shadow/candidate write in ${age}s (>${STALE_SECONDS}s)"
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
