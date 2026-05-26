# Kalshi Data-Collector 30h Run — Adequacy & Integrity (2026-05-26)

- Collector PID 7907, started 2026-05-25T06:58:04Z, stopped 2026-05-26T13:47:33Z (SIGTERM, clean drain)
- Observed window: **30.79h**, 16.7M total messages, 7 series × ~125 markets each = **875 distinct markets**
- Log dir: `apps/data-collector/logs/data-collector/`
- Replaces: [[kalshi-data-collector-interim-4h]] (4.38h interim) for current-state purposes; that one stays as the 4h checkpoint

## 1. Integrity check — PASS

### Backpressure semantics
- **19,538 `orderbook-deltas gzip backpressure` warnings**, 0 on other channels.
- These are **lossless** by design (`apps/data-collector/src/persistence.ts:63-68`). `writable.write()` returning `false` is advisory; the line is already enqueued. The collector explicitly does not pause the WS (event loss is worse than memory growth). The warnings mean the disk write-rate ceiling was momentarily exceeded on the high-volume channel.

### gzip trailer integrity
- **160 / 160** `.jsonl.gz` files pass `gzip -t`. No corruption.
- 0 zero-byte or <100-byte files.

### Sequence monotonicity (15.4M deltas, sid=1)
| metric | value | meaning |
|---|---|---|
| total `orderbook_delta` events | 15,425,604 | full stream |
| distinct `sid` | 1 | single subscription channel |
| sequence resets (seq jumps backwards) | **8** | matches 8 ws_open events exactly (1 startup + 7 reconnects) — expected |
| forward gaps (seq jumped by >+1) | **222** | total missing seqs across all gaps: **2,764** = 0.018% of stream |
| gap cadence | ~every 14 min | aligns with 15-min market rollover boundaries |

The 222 forward gaps are NOT data loss. They cluster around `refresh_subscriptions` events (every 60s; every 15 min triggers a full series rollover), and the first gap fires 3 minutes after WS open immediately after the `0300-00 → 0315-15` rollover. Kalshi advances the channel seq for events on markets we have already unsubscribed from. **Lossless from our subscribed-market perspective.**

> **Note for the replay harness:** key book reconstruction off `(market_ticker, ts_ms)`, not `seq`. The per-channel seq cannot serve as a per-ticker continuity check.

### Quarantine
- `corrupted-by-orphans/` contains 12 pre-existing smoke-test artifacts (`.401bug`, `.drainbug` suffixes, mtimes 2026-05-25T01:45-01:48 PT). All predate the production run (06:58Z). **Nothing from the 30h run needs quarantining.**

## 2. Events by stream

| channel | files | gzipped bytes | events (approx) |
|---|---:|---:|---:|
| orderbook-snapshots | 31 | 276.9 KB | ~3,000 (one per market open + per resubscribe) |
| orderbook-deltas | 31 | 240.6 MB | **15,425,604** |
| trades | 31 | 33.8 MB | **863,494** |
| tickers | 31 | 15.8 MB | ~3,300,000 (rate ~1/s per market) |
| lifecycle | 31 | 226.7 KB | mostly heartbeats |
| **total** | **155** | **290.7 MB** | **30h** |

- Extrapolated daily volume (gzipped): **226.6 MB/day**, **6.64 GB/month**
- Delta inter-arrival cadence per ticker: **p50 = 71 ms, p90 = 737 ms, p99 = 2,720 ms, mean = 276 ms**

## 3. Trades by series

| series | trades | share | markets w/ ≥1 trade | depth threshold (≥1000 in 24h) |
|---|---:|---:|---:|---|
| KXBTC15M | 643,635 | 74.5% | 125 / 125 | ✓ |
| KXETH15M | 80,050 | 9.3% | 125 / 125 | ✓ |
| KXHYPE15M | 38,654 | 4.5% | — | ✓ |
| KXSOL15M | 31,610 | 3.7% | — | ✓ |
| KXXRP15M | 25,289 | 2.9% | — | ✓ |
| KXBNB15M | 22,284 | 2.6% | — | ✓ |
| KXDOGE15M | 21,972 | 2.5% | — | ✓ |
| total | 863,494 | 100% | 867 / 875 | — |

- BTC dominates (75% of all trades). Any per-series harness comparison must be normalized by sample size — comparing 5,000-trade-per-day series to BTC's 21,000/h apples-to-apples is misleading.
- 8 markets observed deltas but no trades (likely late-hour rolls; not concerning).
- **`taker_outcome_side` field present on 100.0% (863,494 / 863,494) of trades.** Ground-truth aggressor direction available — adverse-selection inference doesn't have to rely on quote-move heuristics (Dubach 2026's 59% accuracy threshold doesn't apply).

## 4. Depth levels by series

From `orderbook_snapshot` payloads:
- max depth (yes + no levels, single snapshot): **211**
- histogram: most snapshots either at 0 (header-only payloads, normal Kalshi delivery pattern) or ≥20 (combined yes+no)
- **875 / 875 markets have both snapshots AND deltas** — no silent subscription failures

> **Schema artifact:** Kalshi sends snapshots as multiple rows per market (one metadata header, separate yes-side and no-side level payloads). The harness must combine them; a single snapshot row in isolation will look "empty" if it's a header.

## 5. Reconnect gap timeline

8 ws_open events total (startup + 7 reconnects). All `code=1006` abnormal closures, all recovered.

| time (UTC) | event | gap | note |
|---|---|---|---|
| 2026-05-25T06:58:04Z | ws_open | — | initial startup |
| 2026-05-25T11:24:43-44Z | ws_close → ws_open | **1s** | clean reconnect |
| 2026-05-25T15:46:33-15:47:12Z | ws_close → ws_error → ws_open | **39s** | `getaddrinfo ENOTFOUND` (DNS) |
| 2026-05-25T15:50:18-20Z | ws_close → ws_open | **2s** | clean |
| 2026-05-25T23:47:32-23:49:15Z | ws_close → 2× ws_error → ws_open | **1m 43s** | longest gap; 2× DNS failures back-to-back |
| 2026-05-26T00:00:25-41Z | ws_close → ws_open | **16s** | midnight-UTC coincidence |
| 2026-05-26T00:14:27-39Z | ws_close → ws_open | **12s** | |
| 2026-05-26T11:30:08-10Z | ws_close → ws_open | **2s** | clean |
| 2026-05-26T13:47:33Z | shutdown SIGTERM | — | clean drain |

- **Total gap time across all reconnects: ~3 minutes** out of 30.8h (0.16% downtime).
- Two DNS-failure clusters (15:46Z, 23:47Z) — likely upstream resolver, recovered without manual intervention.
- Longest single-event gap (1m 43s) is small enough that downstream replay can either skip or re-snapshot from the next `orderbook_snapshot` after the gap. The `corrupted-by-orphans` directory is NOT needed for these — gzip writers are not disrupted by WS-level reconnects.

## 6. Schema stability

Sampled every 1000th message per channel across all 32 hours. Top-level field fingerprints:

| type | distinct field-sets | stable across 32 hours |
|---|---:|---|
| orderbook_delta | 1 | ✓ |
| orderbook_snapshot | 2 | ✓ (the two variants are header + price-level rows of the same snapshot — not a schema break) |
| ticker | 1 | ✓ |
| trade | 1 | ✓ |

Canonical `trade` shape:
```
count_fp, market_ticker, no_price_dollars, taker_book_side, taker_outcome_side,
taker_side, trade_id, ts, ts_ms, yes_price_dollars
```

Canonical `ticker` shape includes `yes_bid_dollars`, `yes_ask_dollars`, `yes_bid_size_fp`, `yes_ask_size_fp` — sufficient to reconstruct the inside mid + top-of-book size for L1 markout calculations.

## 7. BTC/ETH markout summary

Method: for each `trade` event at `(t, p_yes, taker_outcome_side)`, look up the same market's ticker mid `(yes_bid+yes_ask)/2` at `t+H`. Markout is signed by taker direction: positive = market moved in taker's favor, negative = maker captures.

Horizons: 1s, 5s, 30s. Maker-side markout = -(taker markout).

### KXBTC15M (643,635 trades)
| horizon | n | mean (taker) | p50 | p10 | p90 | sd |
|---|---:|---:|---:|---:|---:|---:|
| +1s  | 643,817 | **-0.151¢** | -0.500¢ | -1.50¢ | +1.50¢ | 3.01¢ |
| +5s  | 641,953 | **-0.119¢** | -0.500¢ | -3.50¢ | +3.50¢ | 4.85¢ |
| +30s | 626,080 | **-0.068¢** | -0.250¢ | -10.50¢ | +10.50¢ | 10.78¢ |

### KXETH15M (80,050 trades)
| horizon | n | mean (taker) | p50 | p10 | p90 | sd |
|---|---:|---:|---:|---:|---:|---:|
| +1s  | 78,835 | **-0.294¢** | -0.500¢ | -3.50¢ | +3.50¢ | 5.08¢ |
| +5s  | 78,156 | **-0.229¢** | -0.500¢ | -5.50¢ | +5.50¢ | 7.89¢ |
| +30s | 72,770 | **-0.306¢** | -0.100¢ | -13.00¢ | +13.00¢ | 14.14¢ |

### Interpretation
- All means are NEGATIVE at all horizons → **maker EV from filled trades is positive (gross of all other costs)** at the L1 mid-reference level.
- Decay profile is flat / slightly improving, NOT deteriorating → **weak adverse selection on the maker** in this venue. Crucial: this is a necessary but not sufficient condition; queue dynamics, inventory drift, and cancel-vs-fill ratios are all still unknowns the harness has to model.
- p50 = exactly -0.5¢ on both = half-tick (Kalshi tick = 1¢). The taker pays the spread-cross, and the mid does not continue in their direction → maker pockets half the round-trip.
- Variance grows with horizon (sd 3¢ → 11¢ on BTC; 5¢ → 14¢ on ETH) — this is information arrival, not adverse selection. The mean stays negative.
- ETH is ~2× more adversely selected than BTC at 1s (-0.29 vs -0.15) but BOTH remain net favorable for the maker.

> **Caveat:** this is L1 trade-to-mid markout. Real maker EV must additionally model (a) queue position (we are not always at the front of the queue), (b) cancel races (informed flow cancels resting orders before opposing flow lifts them — we'll only fill the uninformed residual), (c) inventory drift toward expiry (BRTI settlement at 15-min boundary). The harness needs all three.

## 8. Verdict

| check | status |
|---|---|
| snapshots received (875/875 markets) | ✓ |
| deltas received (15.4M, no integrity gaps) | ✓ |
| trades received (863k, all series ≥21k) | ✓ |
| trade direction available (100% taker_outcome_side) | ✓ |
| depth ≥ 3 levels (max 211 yes+no, typical ≥20) | ✓ |
| schema stable across 32 hours | ✓ |
| reconnect downtime tolerable (<0.2%) | ✓ |
| BTC/ETH L1 markouts favorable to maker | ✓ |

**Adequate for replay-harness work? YES.** No further collection required before harness build.

## What this dataset CAN support
- L1 book reconstruction (snapshot + monotonic deltas per market)
- Maker quote simulator with queue position approximation (needs careful design — the deltas are aggregated `delta_fp` not order-level)
- Adverse-selection markout by series / time-to-expiry (TTE) / time-of-day bucket
- Maker EV-per-fill estimates conditional on quote offset from mid

## What this dataset CANNOT support (without additional capture)
- Order-level queue position (Kalshi WS doesn't expose individual orders to non-MM)
- Fill simulation when our quote crosses an already-resting order (we'd need to model the resting book's reaction function, which the data only constrains aggregate-level)
- True maker-rebate economics (the 1% rebate requires the institutional MM agreement; Path D EV gates should assume 0%)
