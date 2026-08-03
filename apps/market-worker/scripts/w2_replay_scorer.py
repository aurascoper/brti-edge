#!/usr/bin/env python3
"""W2 prereg §5/§9 replay scorer — first-fire taker replay with persistence fill rule.

Implements the trade simulation of docs/research/
kx15m-w2-btc-stratified-shadow-preregistration.md:

  - first non-SKIP decision per ticker, 1 contract, hold to settlement
  - fill rule (NEXT-SCAN fallback variant, §5): the trade fills only if the
    same ticker's next shadow-log row (~1 scan interval later) still shows the
    fired side's ask <= the signal-time ask A; fill price is A, never better.
    A first fire with no subsequent row for its ticker cannot demonstrate
    persistence and counts as a NO-FILL (conservative).
  - fees: 0.07 * P * (1-P) per contract (general Kalshi taker schedule)
  - no-fills excluded from P&L, counted, and scored counterfactually at their
    marks as a fade-adverse-selection diagnostic (reported, never gated)

Strata (§3): S1 = KXBTC15M (promotable; gates G1/G2/G3/G6 computed here),
S2 = KXETH15M+KXSOL15M, S3 = everything else. Same rule for all strata.

Read-only. Usage:
  python3 scripts/w2_replay_scorer.py --since 2026-08-02T04:16:47Z --until 2026-08-03T10:16:47Z
"""
from __future__ import annotations

import argparse
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

LOGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")

S1 = {"KXBTC15M"}
S2 = {"KXETH15M", "KXSOL15M"}

GATE_PNL_CENTS = 2.5      # G1 / G6 threshold, ¢/contract
GATE_MIN_N = 200          # G3
BLOCK_HOURS = 6           # G6 leave-one-block-out granularity


def load_jsonl(name):
    path = os.path.join(LOGS, name)
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def ts_ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def fee(p):
    # Kalshi rounds the per-order fee UP to the next cent. At 1 contract this
    # is worth ~0.3-0.5¢/trade vs the raw formula — flattery if omitted.
    return math.ceil(0.07 * p * (1 - p) * 100) / 100


def stratum(series):
    if series in S1:
        return "S1"
    if series in S2:
        return "S2"
    return "S3"


def mean_ci(xs):
    n = len(xs)
    m = sum(xs) / n
    if n < 2:
        return m, float("nan"), float("nan")
    var = sum((x - m) ** 2 for x in xs) / (n - 1)
    se = math.sqrt(var / n)
    return m, m - 1.96 * se, m + 1.96 * se


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    args = ap.parse_args()
    t0, t1 = ts_ms(args.since), ts_ms(args.until)

    settle = {}
    for r in load_jsonl("kalshi-settlement-validation.jsonl"):
        if r.get("kalshi_result") in ("yes", "no") and r.get("close_time"):
            ct = ts_ms(r["close_time"])
            if t0 <= ct <= t1:
                settle[r["ticker"]] = 1.0 if r["kalshi_result"] == "yes" else 0.0

    # shadow rows grouped per ticker, in append (time) order, window-filtered
    per_ticker = defaultdict(list)
    for r in load_jsonl("kalshi-shadow.jsonl"):
        t = ts_ms(r["ts"])
        if t0 <= t <= t1:
            per_ticker[r["ticker"]].append(r)

    trades = []       # filled
    no_fills = []     # signal existed, persistence failed or unverifiable
    for ticker, rows in per_ticker.items():
        if ticker not in settle:
            continue
        y = settle[ticker]
        for i, r in enumerate(rows):
            side = r.get("side")
            if side not in ("YES", "NO"):
                continue
            ask_key = "best_yes_ask" if side == "YES" else "best_no_ask"
            a = r.get(ask_key)
            if a is None or not (0 < a < 1):
                break  # first fire had no usable quote: no trade for this ticker
            win = y if side == "YES" else 1.0 - y
            pnl = (win - a) - fee(a)
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            persisted = (
                nxt is not None
                and nxt.get(ask_key) is not None
                and nxt[ask_key] <= a
            )
            rec = {
                "ticker": ticker, "series": r["series"], "side": side,
                "ask": a, "pnl": pnl, "ts_ms": ts_ms(r["ts"]),
                "verifiable": nxt is not None,
            }
            (trades if persisted else no_fills).append(rec)
            break  # first fire only

    print(f"window: {args.since} -> {args.until}")
    print(f"settled tickers in window: {len(settle)}")
    print(f"first-fire signals: {len(trades) + len(no_fills)}  "
          f"filled: {len(trades)}  no-fill: {len(no_fills)} "
          f"({len(no_fills) / max(1, len(trades) + len(no_fills)) * 100:.1f}%)")

    for s in ("S1", "S2", "S3"):
        fills = [t for t in trades if stratum(t["series"]) == s]
        misses = [t for t in no_fills if stratum(t["series"]) == s]
        print(f"\n--- {s} ({'promotable' if s == 'S1' else 'report-only'}) ---")
        if not fills:
            print("  no filled trades")
            continue
        xs = [t["pnl"] for t in fills]
        m, lo, hi = mean_ci(xs)
        wins = sum(1 for x in xs if x > 0)
        print(f"  n_filled={len(fills)}  mean {m * 100:+.2f}¢/ct  "
              f"95% CI [{lo * 100:+.2f}¢, {hi * 100:+.2f}¢]  "
              f"hit {wins}/{len(fills)} ({wins / len(fills) * 100:.1f}%)")
        print(f"  no-fill rate: {len(misses)}/{len(fills) + len(misses)} "
              f"({len(misses) / max(1, len(fills) + len(misses)) * 100:.1f}%)")
        if misses:
            mm, _, _ = mean_ci([t["pnl"] for t in misses])
            print(f"  fade diagnostic — counterfactual P&L of no-fills at their marks: "
                  f"{mm * 100:+.2f}¢/ct (n={len(misses)})")
        # leave-one-block-out (G6): drop the best 6h block, re-aggregate
        blocks = defaultdict(list)
        for t in fills:
            blocks[int(t["ts_ms"] // (BLOCK_HOURS * 3600 * 1000))].append(t["pnl"])
        if len(blocks) > 1:
            best = max(blocks, key=lambda b: sum(blocks[b]))
            rest = [x for b, v in blocks.items() if b != best for x in v]
            rm = sum(rest) / len(rest) if rest else float("nan")
            print(f"  leave-one-block-out: best 6h block removed -> "
                  f"{rm * 100:+.2f}¢/ct over n={len(rest)}")
        if s == "S1":
            g1 = m * 100 >= GATE_PNL_CENTS
            g2 = lo * 100 > 0
            g3 = len(fills) >= GATE_MIN_N
            g6 = len(blocks) > 1 and rest and (rm * 100 >= GATE_PNL_CENTS)
            print(f"  gates: G1({'PASS' if g1 else 'FAIL'}) "
                  f"G2({'PASS' if g2 else 'FAIL'}) "
                  f"G3({'PASS' if g3 else 'FAIL'}, n={len(fills)}) "
                  f"G6({'PASS' if g6 else 'FAIL'})")

    per_series = defaultdict(list)
    for t in trades:
        per_series[t["series"]].append(t["pnl"])
    print("\n--- per series (filled) ---")
    for s, xs in sorted(per_series.items(), key=lambda kv: -sum(kv[1])):
        print(f"  {s:<11} n={len(xs):>4}  {sum(xs) / len(xs) * 100:+6.2f}¢/ct")


if __name__ == "__main__":
    main()
