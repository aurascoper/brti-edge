#!/bin/bash
# run-worker-shadow.sh — launchd entry point for the Kalshi scan worker. SHADOW ONLY.
#
# Live trading is paused (CLAUDE.md). This runs the scan/shadow loop with all
# three order gates hard-pinned OFF, here AND in the plist's EnvironmentVariables
# (belt + suspenders). worker.ts's env loader only sets a var when it is unset
# (src/kalshi/worker.ts:826), so these exported values always win — the creds
# .env at ~/Developer/live_trading/.env can never flip them on.
#
# Unlike `pnpm kalshi-dev` (tsx *watch*, a dev convenience that restarts on file
# edits), this execs plain tsx so launchd's KeepAlive is the sole restart
# authority. `exec` replaces this shell with node, so `launchctl stop` delivers
# SIGTERM straight to the worker with no orphaned pnpm/tsx left behind.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # -> apps/market-worker

export KALSHI_ALLOW_ORDERS=0   # worker-level kill switch: submit() returns 403
export KALSHI_AUTO_SUBMIT=0    # no auto-submit; manual confirm would be required
export KALSHI_DUST_ENABLED=0   # dust executor fully disabled (not merely dry-run)

exec node_modules/.bin/tsx src/kalshi/worker.ts
