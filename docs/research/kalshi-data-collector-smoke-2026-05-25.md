
> @polyterminal/data-collector@0.0.1 report /Users/aurascoper/Developer/polyterminal/apps/data-collector
> tsx src/adequacyReport.ts "--" "--since=2026-05-25T06:48:00Z" "--until=2026-05-25T06:53:00Z"

# Kalshi Data-Collector Adequacy Report

- window: `2026-05-25T06:48:00.000Z` → `2026-05-25T06:53:00.000Z`
- log dir: `/Users/aurascoper/Developer/polyterminal/apps/data-collector/logs/data-collector`
- files matched: 5
- observed window: 0.07h

## 1. Events per market

| series | markets | snapshots | deltas | trades | total |
|---|---:|---:|---:|---:|---:|
| KXBNB15M | 1 | 1 | 1496 | 24 | 1521 |
| KXBTC15M | 1 | 1 | 11829 | 1174 | 13004 |
| KXDOGE15M | 1 | 1 | 852 | 23 | 876 |
| KXETH15M | 1 | 1 | 5482 | 149 | 5632 |
| KXHYPE15M | 1 | 1 | 2674 | 62 | 2737 |
| KXSOL15M | 1 | 1 | 1760 | 27 | 1788 |
| KXXRP15M | 1 | 1 | 2100 | 33 | 2134 |

- distinct markets observed: 7
- markets with at least one trade: 7
- markets with at least one delta: 7

## 2. Depth levels observed (from orderbook snapshots)

- max depth levels (yes + no, single snapshot): **208**
- histogram (yes + no combined per snapshot):

| bucket | count |
|---|---:|
| 20+ | 7 |

## 3. Trade prints observed

- total trade events: **1492**
- across 7 markets
- rate: 22416.1 trades/hour
- fields observed on trade messages:

| field | count |
|---|---:|
| `trade_id` | 1492 |
| `market_ticker` | 1492 |
| `yes_price_dollars` | 1492 |
| `no_price_dollars` | 1492 |
| `count_fp` | 1492 |
| `taker_side` | 1492 |
| `taker_outcome_side` | 1492 |
| `taker_book_side` | 1492 |
| `ts` | 1492 |
| `ts_ms` | 1492 |

## 4. Quote-update cadence (delta inter-arrival, per ticker)

- sample size: 6207
- p50: 56 ms
- p90: 495 ms
- p99: 1940 ms
- mean: 194 ms

## 5. Book reconstruction sanity

- tickers with both snapshots and deltas: 7 / 7
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
| orderbook-snapshots | 1 | 2.9KB |
| orderbook-deltas | 1 | 430.4KB |
| trades | 1 | 60.7KB |
| tickers | 1 | 35.9KB |
| lifecycle | 1 | 855B |

- total bytes in window: 530.8KB
- extrapolated to 24h: **186.9MB/day**
- extrapolated to 30d: 5.48GB

## 7. Trade direction / aggressor side

- trades with non-null `taker_side` (yes/no): 1492 / 1492 (100.0%)

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
| KXBNB15M | 24 | ✗ |
| KXBTC15M | 1174 | ✓ |
| KXDOGE15M | 23 | ✗ |
| KXETH15M | 149 | ✗ |
| KXHYPE15M | 62 | ✗ |
| KXSOL15M | 27 | ✗ |
| KXXRP15M | 33 | ✗ |

## Verdict

| check | status |
|---|---|
| snapshots received | ✓ |
| deltas received | ✓ |
| trades received | ✓ |
| trade direction available (≥95%) | ✓ |
| depth ≥ 3 levels | ✓ |

**Adequate for replay harness work?** YES
