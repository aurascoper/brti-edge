#!/usr/bin/env python3
# =============================================================================
# DISCOVERY ONLY. Optimistic generic-fill proxy. Not a v2 gate. Do not use for
# deployment or prereg pass/fail.
#
# This measures markout on EVERY trade (as if a maker were always filled on the
# favorable side). v2's actual back-of-queue fills select for swept/informed
# flow, under which this signal INVERTS sign. The deployment-grade, policy-
# conditioned gate is apps/data-collector/src/replay/v2Markout.ts.
# =============================================================================
"""DISCOVERY ONLY — optimistic generic-fill proxy; NOT a v2 gate (see banner above).

Maker post-fill markout / adverse-selection scorer for Kalshi 15M crypto binaries.

WHY THIS EXISTS
---------------
The Layer-1/Layer-2 Brier bakeoff (score.py) tests *forecast skill* over the market
price. On the design corpus that test is underpowered: only ~118 in-band binary
resolutions, so its 5pp gate is essentially un-clearable for any realistic edge size
(min detectable effect ~8pp at n=118).

A *maker* strategy (btcMakerV2) does not live or die by forecast skill. Its P&L is the
half-spread it captures minus the adverse selection it suffers when informed flow runs
it over. That question is answerable RIGHT NOW with adequate power: KXBTC15M alone logs
~3.4M trades/24h. This scorer measures it directly.

THE METRIC
----------
For every observed trade, the resting maker took the OPPOSITE side of the taker:
    taker_side == "yes"  -> taker bought YES  -> maker SOLD YES (short),  maker_dir = -1
    taker_side == "no"   -> taker bought NO   -> maker BOUGHT YES (long),  maker_dir = +1
(We key everything off taker_side, not taker_book_side: economically the aggressor's
outcome demand is unambiguous even though YES/NO books cross.)

Mark the maker's resulting position to the prevailing BBO mid at horizon tau:
    pnl(tau)  = maker_dir * (mid_{t+tau} - P)      [cents/contract, P = yes fill price]
    capture   = maker_dir * (mid_t      - P)       [the half-spread you filled on; >0]
    adverse(tau) = capture - pnl(tau)              [erosion of the captured spread]

pnl(tau) is the maker's full mark-to-mid edge per fill INCLUDING spread capture. If its
mean is positive with a CI excluding zero at your quote-lifetime horizon (after fees),
there is structural maker edge. n is in the hundred-thousands, so the CLT SE is tiny and
the test is genuinely powered.

CAVEAT (honest): this is the markout of fills that *actually happened*. Our own quote
would only fill when it was at BBO and ahead in queue, so realized-trade markout is an
optimistic proxy. The maker_fill_filter() hook is where you tighten that assumption.

USAGE
-----
    python autoresearch_layer2/markout.py --since 2026-06-05T08:00:00Z \
                                          --until 2026-06-05T14:00:00Z
    python autoresearch_layer2/markout.py --hours 3            # last 3 present trade-hours
    python autoresearch_layer2/markout.py --series KXBTC15M --hours 6
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np

# ----------------------------------------------------------------------------- config
LOG_DIR_DEFAULT = os.path.join(
    os.path.dirname(__file__), "..", "apps", "data-collector", "logs", "data-collector"
)
OUT_DIR_DEFAULT = os.path.join(os.path.dirname(__file__), "..", "analysis", "markout")

HORIZONS_S = (1, 2, 5, 10, 30, 60)   # post-fill markout horizons (seconds)
STALE_MS = 15_000                    # ignore a BBO quote older than this vs the target time
KALSHI_FEE_RATE = 0.07               # 7% of profit on winning contracts (matches score.py)
MIN_MID, MAX_MID = 0.02, 0.98        # require a genuine two-sided book (drop degenerate 0/1)

SERIES_ALL = (
    "KXBTC15M", "KXETH15M", "KXSOL15M", "KXBNB15M",
    "KXDOGE15M", "KXXRP15M", "KXHYPE15M",
)


# ------------------------------------------------------------------------- file access
def parse_iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def hour_keys(since_ms: int, until_ms: int) -> list[str]:
    """UTC hour-bucket strings 'YYYY-MM-DDTHH' spanning [since, until)."""
    t = datetime.fromtimestamp(since_ms / 1000, timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )
    end = datetime.fromtimestamp(until_ms / 1000, timezone.utc)
    out = []
    while t < end:
        out.append(t.strftime("%Y-%m-%dT%H"))
        t += timedelta(hours=1)
    return out


def iter_records(channel: str, hours: list[str], log_dir: str):
    """Yield raw.msg dicts (+ recv_ts_ms) for a channel across the given hour buckets.

    Tolerates torn gzip members (the hard-kill artifact handled elsewhere in the repo):
    a truncated trailing member just ends that file early.
    """
    for hk in hours:
        path = os.path.join(log_dir, f"{channel}-{hk}.jsonl.gz")
        if not os.path.exists(path):
            continue
        try:
            with gzip.open(path, "rt") as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                        yield rec["raw"]["msg"]
                    except (json.JSONDecodeError, KeyError):
                        continue
        except (EOFError, OSError, gzip.BadGzipFile):
            continue  # torn member; salvage what we read


def latest_present_hours(channel: str, n: int, log_dir: str) -> list[str]:
    pat = re.compile(rf"{re.escape(channel)}-(\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}})\.jsonl\.gz$")
    hks = []
    for p in glob.glob(os.path.join(log_dir, f"{channel}-*.jsonl.gz")):
        m = pat.search(os.path.basename(p))
        if m:
            hks.append(m.group(1))
    return sorted(set(hks))[-n:]


# --------------------------------------------------------------------------- mid index
def build_mid_index(hours: list[str], log_dir: str) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Per market_ticker -> (sorted ts_ms array, mid array) from two-sided BBO ticks."""
    raw: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for m in iter_records("tickers", hours, log_dir):
        try:
            bid = float(m["yes_bid_dollars"])
            ask = float(m["yes_ask_dollars"])
            ts = int(m["ts_ms"])
        except (KeyError, ValueError, TypeError):
            continue
        if not (MIN_MID <= bid < ask <= MAX_MID):
            continue  # need a genuine two-sided near-money quote
        raw[m["market_ticker"]].append((ts, (bid + ask) / 2.0))
    index: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for tk, rows in raw.items():
        rows.sort(key=lambda r: r[0])
        ts = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        mid = np.fromiter((r[1] for r in rows), dtype=np.float64, count=len(rows))
        index[tk] = (ts, mid)
    return index


def mid_at(idx_ts: np.ndarray, idx_mid: np.ndarray, target_ms: int) -> float:
    """Last BBO mid at or before target_ms, in CENTS; NaN if none or too stale."""
    j = int(np.searchsorted(idx_ts, target_ms, side="right")) - 1
    if j < 0 or (target_ms - int(idx_ts[j])) > STALE_MS:
        return float("nan")
    return float(idx_mid[j]) * 100.0  # dollars -> cents


# ----------------------------------------------------------------------------- scoring
def score_trades(hours: list[str], log_dir: str, series: tuple[str, ...]) -> dict:
    mid_index = build_mid_index(hours, log_dir)

    # per series -> per horizon -> list of pnl(tau); plus capture list (horizon-independent)
    pnl: dict[str, dict[int, list[float]]] = {s: {h: [] for h in HORIZONS_S} for s in series}
    capture: dict[str, list[float]] = {s: [] for s in series}
    n_trades = {s: 0 for s in series}
    n_no_book = {s: 0 for s in series}

    for m in iter_records("trades", hours, log_dir):
        tk = m.get("market_ticker", "")
        s = tk.split("-", 1)[0]
        if s not in pnl:
            continue
        n_trades[s] += 1
        idx = mid_index.get(tk)
        if idx is None:
            n_no_book[s] += 1
            continue
        idx_ts, idx_mid = idx
        try:
            P = float(m["yes_price_dollars"]) * 100.0          # fill price, cents
            fill_ms = int(m["ts_ms"])
            taker = m["taker_side"]
        except (KeyError, ValueError, TypeError):
            continue
        maker_dir = -1.0 if taker == "yes" else 1.0           # see module docstring

        mid_entry = mid_at(idx_ts, idx_mid, fill_ms)
        if not np.isnan(mid_entry):
            capture[s].append(maker_dir * (mid_entry - P))
        for h in HORIZONS_S:
            mt = mid_at(idx_ts, idx_mid, fill_ms + h * 1000)
            if not np.isnan(mt):
                pnl[s][h].append(maker_dir * (mt - P))

    # aggregate
    per_series = {}
    for s in series:
        cap = np.array(capture[s], dtype=np.float64)
        horizons = {}
        for h in HORIZONS_S:
            arr = np.array(pnl[s][h], dtype=np.float64)
            horizons[h] = _summ(arr, cap)
        per_series[s] = {
            "n_trades": n_trades[s],
            "n_no_book": n_no_book[s],
            "mean_capture_c": float(cap.mean()) if cap.size else float("nan"),
            "n_capture": int(cap.size),
            "horizons": horizons,
        }

    pooled = _pool(per_series)
    verdict = maker_edge_verdict(pooled, KALSHI_FEE_RATE)
    return {
        "window_hours": [hours[0], hours[-1]] if hours else [],
        "series": list(series),
        "horizons_s": list(HORIZONS_S),
        "stale_ms": STALE_MS,
        "fee_rate": KALSHI_FEE_RATE,
        "per_series": per_series,
        "pooled": pooled,
        "verdict": verdict,
    }


def _summ(pnl_arr: np.ndarray, cap_arr: np.ndarray) -> dict:
    n = pnl_arr.size
    if n == 0:
        return {"n": 0, "mean_pnl_c": None, "se_c": None, "ci_low_c": None,
                "ci_high_c": None, "adverse_c": None}
    mean = float(pnl_arr.mean())
    se = float(pnl_arr.std(ddof=1) / np.sqrt(n)) if n > 1 else float("nan")
    cap_mean = float(cap_arr.mean()) if cap_arr.size else float("nan")
    return {
        "n": int(n),
        "mean_pnl_c": mean,                       # maker mark-to-mid edge / fill (cents)
        "se_c": se,
        "ci_low_c": mean - 1.96 * se,
        "ci_high_c": mean + 1.96 * se,
        "adverse_c": cap_mean - mean,             # spread capture eroded by horizon tau
    }


def _pool(per_series: dict) -> dict:
    horizons = {}
    for h in HORIZONS_S:
        means, ns = [], []
        for s in per_series.values():
            hh = s["horizons"][h]
            if hh["n"] and hh["mean_pnl_c"] is not None:
                means.append(hh["mean_pnl_c"]); ns.append(hh["n"])
        if not ns:
            horizons[h] = {"n": 0, "mean_pnl_c": None}
            continue
        ns = np.array(ns); means = np.array(means)
        horizons[h] = {"n": int(ns.sum()),
                       "mean_pnl_c": float((means * ns).sum() / ns.sum())}
    caps = [(s["mean_capture_c"], s["n_capture"]) for s in per_series.values()
            if s["n_capture"]]
    if caps:
        cm = np.array([c for c, _ in caps]); cn = np.array([n for _, n in caps])
        cap_mean = float((cm * cn).sum() / cn.sum())
    else:
        cap_mean = float("nan")
    return {"mean_capture_c": cap_mean, "horizons": horizons}


# ----------------------------------------------------------- VERDICT POLICY  (your call)
def maker_edge_verdict(pooled: dict, fee_rate: float) -> dict:
    """GO / NO-GO on structural maker edge — the maker-axis analog of the 5pp Brier gate.

    TODO(hkinder): this is YOURS to set, and it is load-bearing (cf. the sigma-ceiling and
    YES_MIN_EDGE thresholds in CLAUDE.md). The objective measurement above is done; this is
    the policy layer. Decisions you need to make:

      1. WHICH HORIZON is your binding test? Your quote lifetime. If btcMakerV2 rests quotes
         ~5-10s, score pooled["horizons"][5] or [10], not [60].
      2. HOW MUCH MARGIN over zero? Mean mark-to-mid pnl > 0 is necessary but not sufficient
         once you charge fees + queue risk. Pick a floor in cents (e.g. >= 0.3c/fill after
         fees) AND require the CLT CI to exclude it.
      3. HOW DO FEES BITE? Kalshi takes fee_rate (7%) of profit on WINNERS at settlement, not
         on mark-to-mid. A crude haircut: net ~ mean_pnl_c * (1 - fee_rate). Decide whether
         that is conservative enough, or model settlement fees explicitly.

    Return: {"horizon_s", "net_edge_c", "passes", "rationale"}.
    The default below is a deliberately naive placeholder so the script runs end-to-end —
    replace the marked block with your real rule.
    """
    horizon_s = 10  # placeholder; set to your real quote lifetime
    h = pooled["horizons"].get(horizon_s, {})
    gross = h.get("mean_pnl_c")
    if gross is None:
        return {"horizon_s": horizon_s, "net_edge_c": None, "passes": False,
                "rationale": "no fills with a valid mid at this horizon"}

    # ----- BEGIN placeholder policy — replace with your real thresholds -----------------
    net_edge_c = gross * (1.0 - fee_rate)
    EDGE_FLOOR_C = 0.3
    passes = net_edge_c >= EDGE_FLOOR_C
    rationale = (f"net {net_edge_c:.3f}c/fill at {horizon_s}s "
                 f"{'>=' if passes else '<'} floor {EDGE_FLOOR_C}c (placeholder rule)")
    # ----- END placeholder policy -------------------------------------------------------

    return {"horizon_s": horizon_s, "net_edge_c": net_edge_c,
            "passes": bool(passes), "rationale": rationale}


# ------------------------------------------------------------------------------- report
def print_report(result: dict) -> None:
    w = result["window_hours"]
    print(f"\n=== Maker markout / adverse-selection — {w[0] if w else '?'} … "
          f"{w[-1] if w else '?'} (UTC hour buckets) ===\n")
    pooled = result["pooled"]
    print(f"pooled spread capture at fill: {pooled['mean_capture_c']:+.3f} c/fill\n")
    print(f"{'horizon':>8} {'n_fills':>10} {'mean pnl':>10} {'adverse':>9}  "
          f"(pnl = capture eroded by drift; want pnl > 0)")
    print("-" * 60)
    for h in result["horizons_s"]:
        ph = pooled["horizons"][h]
        # adverse for pooled = capture - pnl
        adv = (pooled["mean_capture_c"] - ph["mean_pnl_c"]) if ph["mean_pnl_c"] is not None else None
        n = ph["n"]; mp = ph["mean_pnl_c"]
        print(f"{h:>7}s {n:>10,} {('%+.3fc' % mp) if mp is not None else 'n/a':>10} "
              f"{('%+.3fc' % adv) if adv is not None else 'n/a':>9}")
    print("\nper-series mean pnl by horizon (cents/fill):")
    cols = "  ".join(f"{h}s" for h in result["horizons_s"])
    print(f"  {'series':<12} {'n_trades':>9} {'no_book':>8}   {cols}")
    for s, d in result["per_series"].items():
        vals = "  ".join(
            (f"{d['horizons'][h]['mean_pnl_c']:+.2f}"
             if d['horizons'][h]['mean_pnl_c'] is not None else "  n/a")
            for h in result["horizons_s"]
        )
        print(f"  {s:<12} {d['n_trades']:>9,} {d['n_no_book']:>8,}   {vals}")
    v = result["verdict"]
    flag = "✅ GO" if v["passes"] else "⛔ NO-GO"
    print(f"\n{flag} — {v['rationale']}")
    print("   (verdict policy is a placeholder — set maker_edge_verdict() to your real gate)\n")


# --------------------------------------------------------------------------------- main
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Maker markout / adverse-selection scorer")
    ap.add_argument("--since", help="ISO8601, e.g. 2026-06-05T08:00:00Z")
    ap.add_argument("--until", help="ISO8601 (exclusive)")
    ap.add_argument("--hours", type=int, help="instead of since/until: last N present trade-hours")
    ap.add_argument("--series", default="all", help="comma list or 'all'")
    ap.add_argument("--log-dir", default=LOG_DIR_DEFAULT)
    ap.add_argument("--out", default=OUT_DIR_DEFAULT)
    args = ap.parse_args(argv[1:])

    series = SERIES_ALL if args.series == "all" else tuple(args.series.split(","))

    if args.hours:
        hours = latest_present_hours("trades", args.hours, args.log_dir)
        if not hours:
            print("no trade-hour files found", file=sys.stderr); return 2
    elif args.since and args.until:
        hours = hour_keys(parse_iso_ms(args.since), parse_iso_ms(args.until))
    else:
        ap.error("provide --since/--until or --hours")
        return 2

    result = score_trades(hours, args.log_dir, series)
    print_report(result)

    os.makedirs(args.out, exist_ok=True)
    tag = f"{hours[0]}_{hours[-1]}".replace(":", "")
    out_path = os.path.join(args.out, f"markout_{tag}.json")
    with open(out_path, "w") as fh:
        json.dump(result, fh, indent=1)
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
