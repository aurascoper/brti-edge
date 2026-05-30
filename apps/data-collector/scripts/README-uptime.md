# Collector uptime hardening

Goal: make the Kalshi data-collector run **continuously and corruption-free** so the
window starting **2026-06-02** clears `continuous_holdout_eligible` (worst-channel
≥99% coverage, ≤1h longest gap, ≥30 hour buckets). The May 25–27 corpus failed that
(59.7% coverage, 15h gap) — and the deficit was **process downtime** (laptop sleep),
not anything an offline search could fix. So this is ops, not autoresearch.

## Why these pieces

| failure mode (observed) | fix here |
|---|---|
| 15h + 3h gaps = laptop slept | `caffeinate -dimsw` held for the supervisor's lifetime |
| process exits / crashes, nothing restarts it | supervisor restart loop + launchd `KeepAlive` |
| socket dies but process wedges (silent stall) | stall watchdog: no `orderbook-deltas` write in `STALE_SECONDS` → drain-restart |
| `.drainbug` quarantine (2026-05-25T06) | `SIGTERM → 5s grace → SIGKILL`, honoring the `closeAsync` trailer drain in `src/index.ts:413` |
| `.401bug` (RSA-PSS auth mid-stream) | out of scope here — already handled by in-process reconnect+re-auth; flag if it recurs |

## Run it

**Simple (a terminal / tmux session):**
```sh
bash scripts/run-collector-supervised.sh
# Ctrl-C sends SIGINT → drains the child cleanly, releases caffeinate, exits.
```

**Set-and-forget (survives reboot, logout, sleep-wake):**
```sh
cp scripts/com.polyterminal.kalshi-collector.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.polyterminal.kalshi-collector.plist
launchctl start com.polyterminal.kalshi-collector
```
Edit the plist's `PATH` first if `pnpm`/`node` aren't under `/opt/homebrew/bin` or
`/usr/local/bin` (`dirname "$(which pnpm)"`). Credentials are NOT in the plist — the
supervisor sources the repo-root `.env` and `apps/data-collector/.env`.

## Verify before the holdout

```sh
# rolling 24h health while collecting:
bash scripts/collector-readiness-check.sh

# the actual holdout window, once it has accumulated:
bash scripts/collector-readiness-check.sh 2026-06-02T00:00:00Z 2026-06-09T00:00:00Z
```
Exit 0 = `continuous_holdout_eligible: true`. **Do not score the v2 holdout until this
returns READY** — otherwise you repeat the void run (`docs/research/kxbtc15m-v2-VOID-…`).

## Tunables (env)

| var | default | meaning |
|---|---|---|
| `COLLECTOR_GRACE_SECONDS` | 5 | SIGTERM→SIGKILL drain window (must exceed the 3s closeAsync timeout) |
| `COLLECTOR_STALE_SECONDS` | 300 | no deltas write this long ⇒ stall ⇒ restart (deltas flush every 5s) |
| `COLLECTOR_WATCH_INTERVAL` | 30 | health-check cadence |
| `COLLECTOR_MIN_UP_SECONDS` | 30 | shorter child life ⇒ exponential backoff (anti crash-loop) |
| `COLLECTOR_MAX_BACKOFF` | 60 | backoff ceiling |

## The uptime "memory" (option #2 wiring)

The supervisor appends one JSON line per lifecycle event to
`ops/state/collector-supervisor.jsonl` — `supervisor_start`, `start`, `child_exit`,
`stale_restart`, `sigkill`, `backoff`, `supervisor_stop`. That file is the queryable
uptime ledger: restart frequency and stall events are the early warning that coverage
is about to slip. A claude-mind memory records that this layer exists and the readiness
command; query it with `recall("collector uptime hardening readiness")`.

> ⚠️ Clamshell caveat: `caffeinate` prevents *idle* and *system* sleep, but closing the
> lid on battery can still force sleep on some Macs. For the holdout week, keep the
> machine **on AC power with the lid open** (or `pmset` clamshell settings), or run the
> collector on an always-on host.
