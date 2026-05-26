# @polyterminal/data-collector

Read-only Kalshi market-data collector. Persists raw WebSocket events for the 7 BRTI-covered KX\*15M crypto series to hourly-rotated gzipped JSONL.

**Does NOT touch the kalshi-worker, its state files, or its log directory. Does NOT place orders. Does NOT subscribe to private channels.**

## What it collects

Public WebSocket channels at `wss://api.elections.kalshi.com/trade-api/ws/v2`:

| Channel | Output file pattern |
|---|---|
| `orderbook_snapshot` (auto-sent on first orderbook subscription) | `orderbook-snapshots-YYYY-MM-DDTHH.jsonl.gz` |
| `orderbook_delta` | `orderbook-deltas-YYYY-MM-DDTHH.jsonl.gz` |
| `trade` | `trades-YYYY-MM-DDTHH.jsonl.gz` |
| `ticker` / `ticker_v2` | `tickers-YYYY-MM-DDTHH.jsonl.gz` |
| connection lifecycle, subscriptions, errors, heartbeats | `lifecycle-YYYY-MM-DDTHH.jsonl.gz` |

Each row is wrapped as `{"recv_ts_ms": <local epoch ms>, "raw": <verbatim Kalshi payload>}` — the original payload shape is preserved for offline parsing.

## Target series

The 7 BRTI-covered crypto 15-minute series (matches `kalshi-worker` BRTI universe; excludes BCH/ADA):

```
KXBTC15M  KXETH15M  KXSOL15M  KXBNB15M  KXDOGE15M  KXXRP15M  KXHYPE15M
```

Markets within each series roll every 15 minutes. The collector enumerates currently-open markets via REST every 60s and diff-subscribes (add new, remove expired).

## Setup

From the polyterminal repo root:

```sh
pnpm install                                # picks up the new workspace package
```

Required env:

```sh
KALSHI_API_KEY_ID         UUID of the Kalshi API key
KALSHI_PRIVATE_KEY_PATH   Path to the RSA private key PEM
```

If unset, both are auto-loaded from `/Users/aurascoper/Developer/live_trading/.env` (same convention the kalshi-worker uses).

Optional env:

| Var | Default | Purpose |
|---|---|---|
| `DATA_COLLECTOR_LOG_DIR` | `logs/data-collector` | Output directory (relative to cwd) |
| `DATA_COLLECTOR_REFRESH_MS` | `60000` | Market-list refresh cadence |
| `DATA_COLLECTOR_HEARTBEAT_MS` | `60000` | Stdout + lifecycle heartbeat cadence |

## Run

**Foreground (Ctrl-C delivers SIGINT cleanly via terminal):**

```sh
cd apps/data-collector
pnpm run start
```

**Background (24h+) — IMPORTANT: invoke tsx directly, NOT through `pnpm run start`:**

```sh
cd apps/data-collector
nohup node_modules/.bin/tsx src/index.ts > "collector-24h-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 &
disown $!
echo "started pid $!"
```

### Why direct tsx (and not `pnpm run start`) for background runs?

`pnpm run start` spawns `pnpm → tsx → node` as a chain. When the controlling terminal is gone and you `kill -TERM <pnpm-pid>`, pnpm doesn't forward the signal to the Node grandchild — Node becomes an orphan attached to init. The grandchild keeps writing to the same gzipped JSONL files. If you start another collector later, both write concurrently and you get interleaved corruption. We tripped this trap during the smoke and lost three runs to it.

Direct `tsx src/index.ts` makes `$!` the actual Node PID, so `kill -TERM` lands on the right process and the shutdown handler (which awaits gzip-trailer flush) actually runs.

## Stop

```sh
# Find the Node process
ps -ef | grep -E 'tsx.*src/index.ts' | grep -v grep

# Graceful: lets every gzip stream emit its trailer (await 'finish' on file stream)
kill -TERM <pid>
```

`SIGINT` (Ctrl-C) also works gracefully when running in foreground.

Drain budget: the shutdown handler awaits `'finish'` on each gzip stream with a 3-second safety timeout per channel. With 5 channels that's a worst-case ~3s wall-clock drain. Allow 5–8s before sending `kill -KILL` as a hard backstop.

`kill -9` (SIGKILL) cannot be caught, so the most recent hour's `.jsonl.gz` will be missing its trailer (~CRC32 + size, the last few hundred bytes). `gunzip` will refuse such a file outright. You can recover most lines with `gunzip -c file.gz 2>/dev/null | head -n <N>`, but it's brittle — don't SIGKILL unless the process is genuinely hung.

## Adequacy report (after ≥24h of data)

```sh
cd apps/data-collector
pnpm run report                                              # last 24h
pnpm run report -- --since=2026-05-25T00:00:00Z --until=2026-05-26T00:00:00Z
```

Output is Markdown to stdout. Pipe to a file if you want:

```sh
pnpm run report > ../docs/research/data-adequacy-2026-05-26.md
```

The report computes the 8 metrics from the Path D decision memo:

1. events per market (per series, snapshots/deltas/trades broken out)
2. depth levels observed (histogram of yes+no level count per snapshot)
3. trade prints observed (total count + fields observed)
4. average quote-update cadence (delta inter-arrival p50/p90/p99)
5. book reconstruction sanity (snapshot+delta coverage by ticker, example payloads)
6. storage/day estimate (gzipped, extrapolated from observed window)
7. trade direction / aggressor side (presence of `taker_side` field; reference Dubach 2026 inference accuracy)
8. AS estimability (per-series trade count vs 1000-per-series rule of thumb)

Final block prints a yes/no verdict for "adequate for replay harness work."

## Things this collector deliberately does NOT do

- Does not subscribe to private channels (`fill`, `market_positions`, `order_status`, `communications`). Those require a maker order to have been placed, which is out of scope until harness gates pass.
- Does not reconstruct the order book at runtime. The replay harness will reconstruct from the persisted deltas offline.
- Does not interact with the kalshi-worker, its state files, or its `logs/kalshi-*.jsonl` files.
- Does not place orders. The Kalshi client adapter is not even imported here — only `KalshiClient` (REST market discovery) and `signRequest` (WS handshake auth) are used.

## Notes on Kalshi auth for WebSocket

The handshake signs path `/trade-api/v2/ws/v2` with the same RSA-PSS scheme as REST. Headers are passed via the `ws` library's `{ headers }` option. Once the connection is up, channels are subscribed via a single `cmd: "subscribe"` message; Kalshi sends back a `subscribed` ack with a server-assigned `sid` per channel.

The auto-emitted first event on any `orderbook_delta` subscription is a full `orderbook_snapshot` for that ticker, then deltas follow.

## Fee schedule note (verified 2026-05-25)

Standard Kalshi crypto KX\*15M markets:

- **Maker fee: $0** (no fee on resting orders that fill)
- **Taker fee: variable, 0.07–7% of contract value depending on contract probability (sliding scale)**

Major-event markets (NFL/NBA/elections) charge a **0.25% flat maker fee** — does NOT apply to KX\*15M.

Per-trade maker rebates (up to 1%, capped $7k/week) require an institutional Market Maker Agreement and are NOT a retail benefit. The Path D EV gates should use the **0% maker fee, no rebate** assumption for any retail backtest.
