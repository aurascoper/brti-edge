
> @polyterminal/data-collector@0.0.1 report /Users/aurascoper/Developer/polyterminal/apps/data-collector
> tsx src/adequacyReport.ts "--" "--since=2026-05-25T06:58:00Z" "--until=2026-05-25T11:11:10Z"

# Kalshi Data-Collector Adequacy Report

- window: `2026-05-25T06:58:00.000Z` → `2026-05-25T11:11:10.000Z`
- log dir: `/Users/aurascoper/Developer/polyterminal/apps/data-collector/logs/data-collector`
- files matched: 30
- observed window: 4.38h

## 1. Events per market

| series | markets | snapshots | deltas | trades | total |
|---|---:|---:|---:|---:|---:|
| KXBNB15M | 18 | 53 | 79768 | 2956 | 82777 |
| KXBTC15M | 18 | 53 | 805343 | 69308 | 874704 |
| KXDOGE15M | 18 | 53 | 93845 | 2666 | 96564 |
| KXETH15M | 18 | 53 | 397923 | 9087 | 407063 |
| KXHYPE15M | 18 | 53 | 163403 | 4985 | 168441 |
| KXSOL15M | 18 | 53 | 145565 | 4027 | 149645 |
| KXXRP15M | 18 | 53 | 137937 | 4149 | 142139 |

- distinct markets observed: 126
- markets with at least one trade: 126
- markets with at least one delta: 126

## 2. Depth levels observed (from orderbook snapshots)

- max depth levels (yes + no, single snapshot): **209**
- histogram (yes + no combined per snapshot):

| bucket | count |
|---|---:|
| 0 | 238 |
| 20+ | 133 |

## 3. Trade prints observed

- total trade events: **97178**
- across 126 markets
- rate: 22210.8 trades/hour
- fields observed on trade messages:

| field | count |
|---|---:|
| `trade_id` | 97178 |
| `market_ticker` | 97178 |
| `yes_price_dollars` | 97178 |
| `no_price_dollars` | 97178 |
| `count_fp` | 97178 |
| `taker_side` | 97178 |
| `taker_outcome_side` | 97178 |
| `taker_book_side` | 97178 |
| `ts` | 97178 |
| `ts_ms` | 97178 |

## 4. Quote-update cadence (delta inter-arrival, per ticker)

- sample size: 125618
- p50: 72 ms
- p90: 703 ms
- p99: 2497 ms
- mean: 278 ms

## 5. Book reconstruction sanity

- tickers with both snapshots and deltas: 126 / 126
- if low: orderbook_delta subscription may be silently failing

- example snapshot payload (truncated to 800 chars):

```json
{
  "type": "orderbook_snapshot",
  "sid": 1,
  "seq": 1,
  "msg": {
    "market_ticker": "KXBNB15M-26MAY250300-00",
    "market_id": "1edb32d5-2a10-4002-b5d9-7059f6d83876",
    "yes_dollars_fp": [
      [
        "0.0010",
        "502.00"
      ],
      [
        "0.0020",
        "1.00"
      ],
      [
        "0.0100",
        "158.00"
      ],
      [
        "0.0110",
        "91.00"
      ],
      [
        "0.0120",
        "83.00"
      ],
      [
        "0.0130",
        "76.00"
      ],
      [
        "0.0140",
        "71.00"
      ],
      [
        "0.0150",
        "177.00"
      ],
      [
        "0.0160",
        "62.00"
      ],
      [
        "0.0170",
        "58.00"
      ],
      [
        "0.0180",
        "1.00"
      ],
      [
        "0.0190",
        "4.00"
```

- example delta payload (truncated to 800 chars):

```json
{
  "type": "orderbook_delta",
  "sid": 1,
  "seq": 8,
  "msg": {
    "market_ticker": "KXBTC15M-26MAY250300-00",
    "market_id": "ea9de313-3518-4162-b6b2-beb8934bbc63",
    "price_dollars": "0.5000",
    "delta_fp": "-64.00",
    "side": "yes",
    "ts": "2026-05-25T06:48:44.274087Z",
    "ts_ms": 1779691724274
  }
}
```

## 6. Storage per day (gzipped)

| channel | files | bytes |
|---|---:|---:|
| orderbook-snapshots | 6 | 41.8KB |
| orderbook-deltas | 6 | 28.7MB |
| trades | 6 | 3.9MB |
| tickers | 6 | 2.2MB |
| lifecycle | 6 | 31.1KB |

- total bytes in window: 34.8MB
- extrapolated to 24h: **190.9MB/day**
- extrapolated to 30d: 5.59GB

## 7. Trade direction / aggressor side

- trades with non-null `taker_side` (yes/no): 97178 / 97178 (100.0%)

- example trade payloads:

```json
{
  "type": "trade",
  "sid": 2,
  "seq": 1,
  "msg": {
    "trade_id": "4a71c273-09cb-4c8e-2adf-9bbc5c1cab4a",
    "market_ticker": "KXBTC15M-26MAY250300-00",
    "yes_price_dollars": "0.7400",
    "no_price_dollars": "0.2600",
    "count_fp": "3.00",
    "taker_side": "no",
    "taker_outcome_side": "no",
    "taker_book_side": "ask",
    "ts": 1779691724,
    "ts_ms": 1779691724285
  }
}
```
```json
{
  "type": "trade",
  "sid": 2,
  "seq": 2,
  "msg": {
    "trade_id": "3a6f50ba-b5e3-62fe-b69e-f37cda3357ae",
    "market_ticker": "KXBTC15M-26MAY250300-00",
    "yes_price_dollars": "0.7400",
    "no_price_dollars": "0.2600",
    "count_fp": "18.28",
    "taker_side": "no",
    "taker_outcome_side": "no",
    "taker_book_side": "ask",
    "ts": 1779691724,
    "ts_ms": 1779691724311
  }
}
```
```json
{
  "type": "trade",
  "sid": 2,
  "seq": 3,
  "msg": {
    "trade_id": "692b140a-2835-64cb-0449-d272415fbe68",
    "market_ticker": "KXBTC15M-26MAY250300-00",
    "yes_price_dollars": "0.7500",
    "no_price_dollars": "0.2500",
    "count_fp": "4.73",
    "taker_side": "yes",
    "taker_outcome_side": "yes",
    "taker_book_side": "bid",
    "ts": 1779691724,
    "ts_ms": 1779691724567
  }
}
```
```json
{
  "type": "trade",
  "sid": 2,
  "seq": 4,
  "msg": {
    "trade_id": "07c1c287-bb39-626b-96fd-a325f5a0dd80",
    "market_ticker": "KXBTC15M-26MAY250300-00",
    "yes_price_dollars": "0.7500",
    "no_price_dollars": "0.2500",
    "count_fp": "25.56",
    "taker_side": "yes",
    "taker_outcome_side": "yes",
    "taker_book_side": "bid",
    "ts": 1779691724,
    "ts_ms": 1779691724606
  }
}
```
```json
{
  "type": "trade",
  "sid": 2,
  "seq": 5,
  "msg": {
    "trade_id": "76b614f8-1cd3-5ffe-4a4a-c2cdae884a1a",
    "market_ticker": "KXBTC15M-26MAY250300-00",
    "yes_price_dollars": "0.7400",
    "no_price_dollars": "0.2600",
    "count_fp": "36.56",
    "taker_side": "no",
    "taker_outcome_side": "no",
    "taker_book_side": "ask",
    "ts": 1779691724,
    "ts_ms": 1779691724679
  }
}
```

- Dubach 2026 (arxiv 2604.24366v2) shows that inferring direction from quote moves alone is only ~59% accurate on prediction markets.
- If `taker_side` is present on ≥ 95% of trades, we have ground-truth direction and adverse-selection estimation is well-posed.

## 8. Enough data to estimate adverse selection?

**Rules of thumb**:
- need ≥ 1,000 directed trades per series to fit even a coarse AS model
- need delta cadence p50 ≤ 1s for post-fill markout at 1-5s horizons
- need depth levels ≥ 3 per side for queue-position simulation

**Per-series trade counts**:
| series | trades | enough? (≥1000 in 24h) |
|---|---:|---|
| KXBNB15M | 2956 | ✓ |
| KXBTC15M | 69308 | ✓ |
| KXDOGE15M | 2666 | ✓ |
| KXETH15M | 9087 | ✓ |
| KXHYPE15M | 4985 | ✓ |
| KXSOL15M | 4027 | ✓ |
| KXXRP15M | 4149 | ✓ |

## Verdict

| check | status |
|---|---|
| snapshots received | ✓ |
| deltas received | ✓ |
| trades received | ✓ |
| trade direction available (≥95%) | ✓ |
| depth ≥ 3 levels | ✓ |

**Adequate for replay harness work?** YES
