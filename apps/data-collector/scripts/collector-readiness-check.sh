#!/usr/bin/env bash
# =============================================================================
# Holdout readiness gate — is the collector's recent data continuity-eligible?
# =============================================================================
# Wraps `pnpm run report` (adequacyReport.ts) and turns its verdict into an
# exit code so it can gate a holdout-go decision or run on a cron/launchd timer.
#
#   exit 0  => continuous_holdout_eligible: true   (worst-channel >=99%, gap <=1h, >=30h)
#   exit 1  => not eligible (or no data) — DO NOT start the 2026-06-02 holdout yet
#
# Usage:
#   bash scripts/collector-readiness-check.sh                       # last 24h
#   bash scripts/collector-readiness-check.sh 2026-06-02T00:00:00Z 2026-06-09T00:00:00Z
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SINCE="${1:-}"
UNTIL="${2:-}"

args=()
[ -n "$SINCE" ] && args+=("--since=$SINCE")
[ -n "$UNTIL" ] && args+=("--until=$UNTIL")

out="$(cd "$APP_DIR" && pnpm run report -- "${args[@]}" 2>/dev/null)"

echo "$out" | grep -iE 'window:|files matched|worst-channel|longest gap|continuous_holdout_eligible|Adequate for replay' || true
echo "----------------------------------------------------------------------"

elig="$(printf '%s\n' "$out" | grep -i 'continuous_holdout_eligible' | grep -ioE 'true|false' | head -1)"

if [ "$elig" = "true" ]; then
  echo "✅ READY — continuous_holdout_eligible: true"
  exit 0
else
  echo "⛔ NOT READY — continuous_holdout_eligible: ${elig:-unknown (no data in window?)}"
  echo "   The 2026-06-02 holdout must NOT be scored until this returns READY."
  exit 1
fi
