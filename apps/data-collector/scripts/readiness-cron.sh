#!/usr/bin/env bash
# =============================================================================
# Daily holdout-readiness probe — 2026-06-02 → 2026-06-09 window
# =============================================================================
# Driven by com.polyterminal.kalshi-readiness.plist (launchd StartCalendarInterval).
# Each run:
#   1. scores the holdout window via collector-readiness-check.sh,
#   2. appends a timestamped verdict block to ops/state/readiness-history.log
#      (the queryable paper trail — grep it to see when coverage flipped),
#   3. ONCE THE WINDOW HAS OPENED, raises a macOS notification with the verdict
#      so slippage is visible day-to-day instead of only at scoring time.
#
# Why local launchd and not /loop or a cloud schedule: the verdict is computed
# from the gz files this collector writes locally — only this host can read them.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HIST="$APP_DIR/ops/state/readiness-history.log"
mkdir -p "$APP_DIR/ops/state"

# The holdout window — these MUST match the policy dates (CLAUDE.md / preregistration).
WIN_START="2026-06-02T00:00:00Z"
WIN_END="2026-06-09T00:00:00Z"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TODAY="$(date -u +%Y-%m-%d)"

# Score the window. rc=0 => continuous_holdout_eligible:true (READY).
out="$(bash "$SCRIPT_DIR/collector-readiness-check.sh" "$WIN_START" "$WIN_END" 2>&1)"
rc=$?
verdict="NOT READY"; [ "$rc" -eq 0 ] && verdict="READY"

{
  echo "===== $NOW  (rc=$rc → $verdict) ====="
  echo "$out"
  echo
} >> "$HIST"

# --- notification policy ------------------------------------------------------
# Default: notify only while the window is open (06-02 .. 06-09 inclusive of the
# closing-morning check), so we don't spam NOT-READY every day BEFORE the window
# even exists. Lexicographic string compare on YYYY-MM-DD is correct for ISO dates.
# To change this (e.g. notify only on a verdict CHANGE, or also pre-window),
# edit the `in_window` test below — that is the one real behavioral knob here.
in_window=false
if [[ "$TODAY" > "2026-06-01" && "$TODAY" < "2026-06-10" ]]; then in_window=true; fi

if $in_window && command -v osascript >/dev/null 2>&1; then
  icon="⛔"; [ "$rc" -eq 0 ] && icon="✅"
  osascript -e "display notification \"$icon holdout window is $verdict\" with title \"Kalshi collector readiness\" subtitle \"$WIN_START → $WIN_END\"" >/dev/null 2>&1 || true
fi

# Exit non-zero when NOT READY so `launchctl list` shows the last status at a glance.
exit "$rc"
