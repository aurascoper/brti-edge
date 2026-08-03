#!/usr/bin/env python3
"""W2 prereg §5/§9 replay scorer — first-fire taker replay with persistence fill rule.

Implements the trade simulation of docs/research/
kx15m-w2-btc-stratified-shadow-preregistration.md:

  - first non-SKIP decision per ticker, 1 contract, hold to settlement
  - fill rule (NEXT-SCAN variant, §5 gate authority): the trade fills only if
    the same ticker's next shadow-log row (the ticker's actual next scan gap,
    median ~15s under an eligible window) still shows the fired side's ask
    <= the signal-time ask A; fill price is A, never better. A first fire with
    no subsequent row cannot demonstrate persistence -> NO-FILL (conservative).
  - a first fire with no usable quote is counted as UNQUOTED (never silently
    dropped) — §4 tripwire: unquoted > 2% of settled tickers marks the window
    suspect (collector degradation hides exactly there)
  - fees: ceil-to-cent of 0.07 * P * (1-P) per contract, rounded for
    float determinism
  - G7 (§8): paired per-ticker Brier differences (mid - model) over ALL
    first-fires with two-sided quotes, fills and no-fills alike (signal
    question, no fill conditioning); one-sided z

Strata (§3): S1 = KXBTC15M (promotable), S2 = KXETH15M+KXSOL15M, S3 = rest.

--interim implements §8a: evaluates the full battery at the harsh bound
(z >= 2.8) and prints ONLY "GO" or "CONTINUE" — no numbers are disclosed.

Read-only. Usage:
  python3 scripts/w2_replay_scorer.py --since <ISO> --until <ISO> [--interim]
"""
from __future__ import annotations

import argparse
import json
import math
import os
from collections import defaultdict
from datetime import datetime

LOGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")

S1 = {"KXBTC15M"}
S2 = {"KXETH15M", "KXSOL15M"}

GATE_PNL_CENTS = 2.5      # G1 / G6 threshold, ¢/contract
GATE_MIN_N = 200          # G3
G2_Z_FINAL = 1.70         # one-sided, α-adjusted for the §8a interim look
G2_Z_INTERIM = 2.80       # §8a early-GO bound
G7_Z = 1.645              # one-sided, fired-subset paired Brier vs mid
BLOCK_HOURS = 6           # G6 leave-one-block-out granularity
UNQUOTED_TRIPWIRE = 0.02  # §4: unquoted/settled above this marks window suspect


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
    # Kalshi rounds the per-order fee UP to the next cent. round(..., 9) first:
    # ceil over a raw float can wobble at exact-cent boundaries (hygiene — the
    # wobble was conservative-only, but reproducibility matters for a gate).
    return math.ceil(round(0.07 * p * (1 - p) * 100, 9)) / 100


def stratum(series):
    if series in S1:
        return "S1"
    if series in S2:
        return "S2"
    return "S3"


def mean_se(xs):
    n = len(xs)
    m = sum(xs) / n
    if n < 2:
        return m, float("nan")
    var = sum((x - m) ** 2 for x in xs) / (n - 1)
    return m, math.sqrt(var / n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    ap.add_argument("--interim", action="store_true",
                    help="§8a day-7 look: full battery at harsh bound, prints ONLY GO/CONTINUE")
    args = ap.parse_args()
    t0, t1 = ts_ms(args.since), ts_ms(args.until)
    out = (lambda *a, **k: None) if args.interim else print

    settle = {}
    for r in load_jsonl("kalshi-settlement-validation.jsonl"):
        if r.get("kalshi_result") in ("yes", "no") and r.get("close_time"):
            ct = ts_ms(r["close_time"])
            if t0 <= ct <= t1:
                settle[r["ticker"]] = 1.0 if r["kalshi_result"] == "yes" else 0.0

    per_ticker = defaultdict(list)
    for r in load_jsonl("kalshi-shadow.jsonl"):
        t = ts_ms(r["ts"])
        if t0 <= t <= t1:
            per_ticker[r["ticker"]].append(r)

    trades = []       # filled
    no_fills = []     # signal existed, persistence failed or unverifiable
    unquoted = []     # first fire had no usable fired-side ask (§4 tripwire)
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
                unquoted.append({"ticker": ticker, "series": r["series"], "side": side})
                break  # first fire only — but never a silent drop
            win = y if side == "YES" else 1.0 - y
            pnl = (win - a) - fee(a)
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            persisted = (
                nxt is not None
                and nxt.get(ask_key) is not None
                and nxt[ask_key] <= a
            )
            byb, bya = r.get("best_yes_bid"), r.get("best_yes_ask")
            rec = {
                "ticker": ticker, "series": r["series"], "side": side,
                "ask": a, "pnl": pnl, "ts_ms": ts_ms(r["ts"]),
                "verifiable": nxt is not None,
                "y": y, "fair": r.get("fair_yes"),
                "mid": (byb + bya) / 2 if byb is not None and bya is not None else None,
            }
            (trades if persisted else no_fills).append(rec)
            break  # first fire only

    n_signals = len(trades) + len(no_fills)
    out(f"window: {args.since} -> {args.until}")
    out(f"settled tickers in window: {len(settle)}")
    out(f"first-fire signals: {n_signals}  filled: {len(trades)}  "
        f"no-fill: {len(no_fills)} ({len(no_fills) / max(1, n_signals) * 100:.1f}%)")
    uq_rate = len(unquoted) / max(1, len(settle))
    out(f"unquoted first-fires: {len(unquoted)} ({uq_rate * 100:.2f}% of settled)"
        + ("  ⚠ TRIPWIRE — window suspect (§4)" if uq_rate > UNQUOTED_TRIPWIRE else ""))

    gates = {}
    for s in ("S1", "S2", "S3"):
        fills = [t for t in trades if stratum(t["series"]) == s]
        misses = [t for t in no_fills if stratum(t["series"]) == s]
        out(f"\n--- {s} ({'promotable' if s == 'S1' else 'report-only'}) ---")
        if not fills:
            out("  no filled trades")
            continue
        xs = [t["pnl"] for t in fills]
        m, se = mean_se(xs)
        wins = sum(1 for x in xs if x > 0)
        z = m / se if se and se > 0 else float("nan")
        out(f"  n_filled={len(fills)}  mean {m * 100:+.2f}¢/ct  se {se * 100:.2f}¢  "
            f"z={z:+.2f}  hit {wins}/{len(fills)} ({wins / len(fills) * 100:.1f}%)")
        out(f"  no-fill rate: {len(misses)}/{len(fills) + len(misses)} "
            f"({len(misses) / max(1, len(fills) + len(misses)) * 100:.1f}%)")
        if misses:
            mm, _ = mean_se([t["pnl"] for t in misses])
            out(f"  fade diagnostic — counterfactual P&L of no-fills at their marks: "
                f"{mm * 100:+.2f}¢/ct (n={len(misses)})")
        blocks = defaultdict(list)
        for t in fills:
            blocks[int(t["ts_ms"] // (BLOCK_HOURS * 3600 * 1000))].append(t["pnl"])
        rm = float("nan")
        if len(blocks) > 1:
            best = max(blocks, key=lambda b: sum(blocks[b]))
            rest = [x for b, v in blocks.items() if b != best for x in v]
            rm = sum(rest) / len(rest) if rest else float("nan")
            out(f"  leave-one-block-out: best {BLOCK_HOURS}h block removed -> "
                f"{rm * 100:+.2f}¢/ct over n={len(rest)}")
        # G7: paired per-ticker Brier differences (mid − model), fills+no-fills
        pairs = [
            (t["mid"] - t["y"]) ** 2 - (t["fair"] - t["y"]) ** 2
            for t in fills + misses
            if t.get("mid") is not None and t.get("fair") is not None
        ]
        z7 = float("nan")
        if len(pairs) >= 2:
            m7, se7 = mean_se(pairs)
            z7 = m7 / se7 if se7 and se7 > 0 else float("nan")
            out(f"  fired-subset paired Brier (mid−model): {m7:+.4f}  z={z7:+.2f}  "
                f"n={len(pairs)} (excl. {len(fills) + len(misses) - len(pairs)} without two-sided quotes)")
        if s == "S1":
            g2_bound = G2_Z_INTERIM if args.interim else G2_Z_FINAL
            gates = {
                "G1": m * 100 >= GATE_PNL_CENTS,
                "G2": not math.isnan(z) and z >= g2_bound,
                "G3": len(fills) >= GATE_MIN_N,
                "G6": not math.isnan(rm) and rm * 100 >= GATE_PNL_CENTS,
                "G7": not math.isnan(z7) and z7 >= G7_Z,
            }
            out("  gates: " + " ".join(
                f"{k}({'PASS' if v else 'FAIL'})" for k, v in gates.items())
                + f"   [G2 bound z≥{g2_bound}]")

    per_series = defaultdict(list)
    for t in trades:
        per_series[t["series"]].append(t["pnl"])
    out("\n--- per series (filled) ---")
    for s, xs in sorted(per_series.items(), key=lambda kv: -sum(kv[1])):
        out(f"  {s:<11} n={len(xs):>4}  {sum(xs) / len(xs) * 100:+6.2f}¢/ct")

    if args.interim:
        # §8a: full battery at the harsh bound; boolean-only disclosure.
        print("GO" if gates and all(gates.values()) else "CONTINUE")


if __name__ == "__main__":
    main()
