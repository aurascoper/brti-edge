#!/usr/bin/env python3
"""W1 fade audit — reproduces the prereg's "13 of 71 fills fade within 2s" claim
(audit F12) from the collector tick archive.

For every W1 S1 (KXBTC15M) fill under the §5 next-scan rule, replays the book
±15s around the signal from orderbook-snapshots + orderbook-deltas and asks
whether the fired side's ask ticked above the signal ask A within 2s. Fills the
archive cannot cover (no snapshot before signal) are ENUMERATED as
INSUFFICIENT, never silently skipped. Also recomputes the prereg §5
sensitivity brackets: as-scored mean, drop-all-fades mean, reprice-fades-1¢
mean.

Usage:
  python3 scripts/w1_fade_audit.py \
      [--since 2026-08-02T04:16:00Z] [--until 2026-08-03T18:37:03Z]

Defaults cover all pre-lock shadow rows (design corpus + W1; 92 S1 fills).
The prereg's official 71 is the W1 proper subset — pass the official W1 span
to reproduce it exactly once its boundaries are transcribed into the annex.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.normpath(os.path.join(HERE, ".."))
LOGS = os.path.join(WORKER, "logs")
ARCHIVE = os.path.normpath(os.path.join(
    WORKER, "..", "data-collector", "logs", "data-collector"))

PRE_WINDOW_MS = 15_000
POST_WINDOW_MS = 15_000
FADE_MS = 2_000


def ts_ms(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def load_jsonl(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows


def w1_s1_fills(t0: float, t1: float):
    """Scorer-identical first-fire persistence fills, S1 only."""
    settle = {}
    for r in load_jsonl(os.path.join(LOGS, "kalshi-settlement-validation.jsonl")):
        if r.get("kalshi_result") in ("yes", "no") and r.get("close_time"):
            settle[r["ticker"]] = 1.0 if r["kalshi_result"] == "yes" else 0.0
    per = defaultdict(list)
    for r in load_jsonl(os.path.join(LOGS, "kalshi-shadow.jsonl")):
        t = ts_ms(r["ts"])
        if t0 <= t <= t1:
            per[r["ticker"]].append(r)
    fills = []
    for ticker, rows in per.items():
        if ticker not in settle or not ticker.startswith("KXBTC15M"):
            continue
        for i, r in enumerate(rows):
            side = r.get("side")
            if side not in ("YES", "NO"):
                continue
            k = "best_yes_ask" if side == "YES" else "best_no_ask"
            a = r.get(k)
            if a is None or not (0 < a < 1):
                break
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            if nxt is not None and nxt.get(k) is not None and nxt[k] <= a:
                fills.append({"ticker": ticker, "side": side, "ask": a,
                              "ts_ms": ts_ms(r["ts"]), "y": settle[ticker]})
            break
    return fills


def hours_for(ms_lo: float, ms_hi: float):
    out = []
    t = ms_lo - (ms_lo % 3_600_000)
    while t <= ms_hi:
        out.append(datetime.fromtimestamp(t / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H"))
        t += 3_600_000
    return out


def archive_rows(hour: str, channel: str, tickers: set[str]):
    """Stream one hour file, return rows whose market_ticker is wanted.
    Reads base + .pN crash-relaunch parts, tolerating truncated members.
    Decompress+prefilter runs in gzcat|grep -F (C speed); python parses
    only the matching lines. Ticker patterns go via a temp file, never
    interpolated into a shell string."""
    import subprocess
    import tempfile
    out = []
    with tempfile.NamedTemporaryFile("w", suffix=".pat", delete=False) as tf:
        tf.write("\n".join(sorted(tickers)) + "\n")
        patfile = tf.name
    try:
        for suffix in ("", ".p2", ".p3", ".p4"):
            path = os.path.join(ARCHIVE, f"{channel}-{hour}{suffix}.jsonl.gz")
            if not os.path.exists(path):
                continue
            gz = subprocess.Popen(["gzcat", path], stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL)
            gr = subprocess.Popen(["grep", "-F", "-f", patfile],
                                  stdin=gz.stdout, stdout=subprocess.PIPE,
                                  text=True, errors="replace")
            gz.stdout.close()  # let gzcat get SIGPIPE if grep exits
            for line in gr.stdout:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            gr.wait()
            gz.wait()  # nonzero on truncated member is fine — partial kept
    finally:
        os.unlink(patfile)
    return out


def replay_fill(fill, snap_rows, delta_rows):
    """Book state around one fill; returns dict with classification."""
    tkr, side, a, t = fill["ticker"], fill["side"], fill["ask"], fill["ts_ms"]
    events = []
    for r in snap_rows:
        msg = (r.get("raw") or {}).get("msg") or {}
        if msg.get("market_ticker") == tkr:
            events.append((r["recv_ts_ms"], "snap", msg))
    for r in delta_rows:
        msg = (r.get("raw") or {}).get("msg") or {}
        if msg.get("market_ticker") == tkr:
            events.append((r["recv_ts_ms"], "delta", msg))
    events.sort(key=lambda e: e[0])
    if not events or events[0][1] != "snap" or events[0][0] > t:
        pre = [e for e in events if e[1] == "snap" and e[0] <= t]
        if not pre:
            return {"class": "INSUFFICIENT", "why": "no snapshot at/before signal"}
    book = {"yes": {}, "no": {}}
    seeded = False
    fired_ask_series = []  # (ts, ask) after each event
    def fired_ask():
        # fired-side ask = 1 - best bid of the OPPOSITE side (client derivation)
        opp = "no" if side == "YES" else "yes"
        bids = [p for p, s in book[opp].items() if s > 0]
        return round(1 - max(bids), 4) if bids else None
    for ets, kind, msg in events:
        if ets > t + POST_WINDOW_MS:
            break
        if kind == "snap":
            book = {"yes": {}, "no": {}}
            for p, s in msg.get("yes_dollars_fp") or []:
                book["yes"][float(p)] = float(s)
            for p, s in msg.get("no_dollars_fp") or []:
                book["no"][float(p)] = float(s)
            seeded = True
        elif seeded:
            sd_ = msg.get("side")
            p = float(msg.get("price_dollars", 0) or 0)
            d = float(msg.get("delta_fp", 0) or 0)
            if sd_ in book and p:
                book[sd_][p] = book[sd_].get(p, 0.0) + d
        if seeded:
            fa = fired_ask()
            if fa is not None:
                fired_ask_series.append((ets, fa))
    if not seeded or not fired_ask_series:
        return {"class": "INSUFFICIENT", "why": "no book state in window"}
    at_signal = [x for ts_, x in fired_ask_series if ts_ <= t]
    in_2s = [x for ts_, x in fired_ask_series if t < ts_ <= t + FADE_MS]
    in_15s = [x for ts_, x in fired_ask_series if t < ts_ <= t + POST_WINDOW_MS]
    faded_2s = any(x > a + 1e-9 for x in in_2s)
    return {
        "class": "FADE_2S" if faded_2s else "STABLE",
        "ask_at_signal": at_signal[-1] if at_signal else None,
        "max_2s": max(in_2s) if in_2s else None,
        "max_15s": max(in_15s) if in_15s else None,
        "events_2s": len(in_2s),
    }


def fee(p: float) -> float:
    return math.ceil(round(0.07 * p * (1 - p) * 100, 9)) / 100


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-08-02T04:16:00Z")
    ap.add_argument("--until", default="2026-08-03T18:37:03Z")
    ap.add_argument("--budget-seconds", type=float, default=480,
                    help="exit cleanly (code 3) after this much wall time; "
                         "progress persists in the checkpoint — rerun to resume")
    ap.add_argument("--checkpoint", default=os.path.normpath(os.path.join(
        WORKER, "..", "..", "analysis", "w2", "w1-fade-checkpoint.jsonl")))
    args = ap.parse_args()
    import time
    t_start = time.monotonic()
    t0, t1 = ts_ms(args.since), ts_ms(args.until)
    fills = w1_s1_fills(t0, t1)
    print(f"# W1 fade audit — {args.since} -> {args.until}")
    print(f"S1 fills under §5 next-scan rule: {len(fills)} "
          f"(prereg official W1 span counts 71)")

    done: dict[str, dict] = {}
    if os.path.exists(args.checkpoint):
        for r in load_jsonl(args.checkpoint):
            done[r["ticker"]] = r
    todo = [f_ for f_ in fills if f_["ticker"] not in done]
    print(f"checkpoint: {len(done)} done, {len(todo)} to go")

    by_hour: dict[str, list] = defaultdict(list)
    for f_ in fills:
        for h in hours_for(f_["ts_ms"] - 3_600_000, f_["ts_ms"] + POST_WINDOW_MS):
            by_hour[h].append(f_)

    cache: dict[tuple[str, str], list] = {}
    todo.sort(key=lambda f_: f_["ts_ms"])  # hour-locality keeps the cache warm
    with open(args.checkpoint, "a") as ck:
        for f_ in todo:
            if time.monotonic() - t_start > args.budget_seconds:
                print(f"BUDGET REACHED — {len(done)}/{len(fills)} in checkpoint; rerun to resume")
                raise SystemExit(3)
            hrs = hours_for(f_["ts_ms"] - 3_600_000, f_["ts_ms"] + POST_WINDOW_MS)
            tk = {f_["ticker"]}
            snaps, deltas = [], []
            for h in hrs:
                for ch, dest in (("orderbook-snapshots", snaps), ("orderbook-deltas", deltas)):
                    key = (ch, h)
                    if key not in cache:
                        wanted = {x["ticker"] for x in by_hour.get(h, [])}
                        cache[key] = archive_rows(h, ch, wanted) if wanted else []
                    dest.extend(r for r in cache[key]
                                if ((r.get("raw") or {}).get("msg") or {}).get("market_ticker") in tk)
            # evict cache entries older than the current fill's window
            for key in [k for k in cache if k[1] < hrs[0]]:
                del cache[key]
            row = {**f_, **replay_fill(f_, snaps, deltas)}
            done[f_["ticker"]] = row
            ck.write(json.dumps(row) + "\n")
            ck.flush()
    results = [done[f_["ticker"]] for f_ in fills if f_["ticker"] in done]

    fades = [r for r in results if r["class"] == "FADE_2S"]
    stable = [r for r in results if r["class"] == "STABLE"]
    insuff = [r for r in results if r["class"] == "INSUFFICIENT"]
    covered = len(fades) + len(stable)
    print(f"\ncovered by archive: {covered}/{len(results)}  "
          f"FADE_2S: {len(fades)}  STABLE: {len(stable)}  INSUFFICIENT: {len(insuff)}")
    if covered:
        print(f"fade rate over covered: {len(fades) / covered:.1%} "
              f"(prereg claim: 13/71 = 18%)")
    for r in insuff:
        print(f"  INSUFFICIENT {r['ticker']} @ {datetime.fromtimestamp(r['ts_ms'] / 1000, tz=timezone.utc).isoformat()}: {r['why']}")

    def pnl(r, reprice=0.0):
        a = r["ask"] + reprice
        win = r["y"] if r["side"] == "YES" else 1.0 - r["y"]
        return (win - a) - fee(a)

    scored = [r for r in results if r["class"] != "INSUFFICIENT"]
    if scored:
        base = sum(pnl(r) for r in scored) / len(scored)
        drop = [r for r in scored if r["class"] != "FADE_2S"]
        drop_m = sum(pnl(r) for r in drop) / len(drop) if drop else float("nan")
        repr_m = sum(pnl(r, 0.01 if r["class"] == "FADE_2S" else 0.0) for r in scored) / len(scored)
        print(f"\nsensitivity (covered fills): as-scored {base * 100:+.2f}¢/ct  "
              f"drop-fades {drop_m * 100:+.2f}¢/ct (n={len(drop)})  "
              f"reprice-fades-1¢ {repr_m * 100:+.2f}¢/ct")
        print("(prereg §5 brackets: drop-all ~+2.2¢, reprice ~+3.7¢, as-scored +3.83¢)")


if __name__ == "__main__":
    main()
