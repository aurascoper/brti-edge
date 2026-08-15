#!/usr/bin/env python3
# =============================================================================
# Polymarket book mirror-consistency check
# =============================================================================
# A Polymarket binary market has two tokens (Up/Down). At any instant the
# books must mirror: best_bid(up) ~= 1 - best_ask(down) and
# best_bid(down) ~= 1 - best_ask(up). A persistent violation means the
# collector is stitching stale snapshots from different moments — exactly the
# corruption that would poison any lead-lag measurement downstream.
#
# Reads pm-book gzip JSONL for one UTC hour, groups snapshots by
# (market, identical src_ts), and checks every complete two-token pair.
#
# Usage:
#   python3 scripts/pm_mirror_check.py --hour 2026-08-15T04
#   python3 scripts/pm_mirror_check.py --latest
#   python3 scripts/pm_mirror_check.py --dir /path/to/logs/polymarket --latest
#
# Exit codes: 0 = pass; 1 = mismatch rate > threshold (default 1%) or no
# comparable pairs found; 2 = usage / missing files.
#
# Stdlib only — no third-party deps.
# =============================================================================

import argparse
import glob
import gzip
import json
import os
import re
import sys

DEFAULT_DIR = "/Users/aurascoper/Developer/brti-edge/apps/data-collector/logs/polymarket"
HOUR_RE = re.compile(r"pm-book-(\d{4}-\d{2}-\d{2}T\d{2})")


def die(msg: str, code: int = 2) -> None:
    print(f"pm_mirror_check: {msg}", file=sys.stderr)
    sys.exit(code)


def latest_hour(log_dir: str) -> str:
    hours = set()
    for path in glob.glob(os.path.join(log_dir, "pm-book-*.jsonl.gz")):
        m = HOUR_RE.search(os.path.basename(path))
        if m:
            hours.add(m.group(1))
    if not hours:
        die(f"no pm-book files under {log_dir}")
    return max(hours)


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def first_key(d: dict, *keys):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def best_prices(row: dict):
    """Extract (best_bid, best_ask) from a pm-book row, tolerating either
    precomputed best_bid/best_ask fields or full bids/asks level arrays
    (entries {price, size} with string or numeric prices)."""
    # Payload may be nested under a single wrapper key.
    for wrapper in ("payload", "book", "data"):
        inner = row.get(wrapper)
        if isinstance(inner, dict):
            row = {**inner, **{k: v for k, v in row.items() if k != wrapper}}
    bb = to_float(first_key(row, "best_bid", "bestBid"))
    ba = to_float(first_key(row, "best_ask", "bestAsk"))
    if bb is None or ba is None:
        bids = first_key(row, "bids", "buys")
        asks = first_key(row, "asks", "sells")
        if isinstance(bids, list) and bids:
            prices = [to_float(lv.get("price")) for lv in bids if isinstance(lv, dict)]
            prices = [p for p in prices if p is not None]
            bb = max(prices) if prices else None
        if isinstance(asks, list) and asks:
            prices = [to_float(lv.get("price")) for lv in asks if isinstance(lv, dict)]
            prices = [p for p in prices if p is not None]
            ba = min(prices) if prices else None
    return bb, ba, row


def main() -> int:
    ap = argparse.ArgumentParser(description="Polymarket two-token book mirror check")
    ap.add_argument("--dir", default=os.environ.get("PM_COLLECTOR_LOG_DIR", DEFAULT_DIR),
                    help="pm-book log directory (default: PM_COLLECTOR_LOG_DIR or repo logs/polymarket)")
    ap.add_argument("--hour", help="UTC hour to check, e.g. 2026-08-15T04")
    ap.add_argument("--latest", action="store_true", help="check the newest hour on disk")
    ap.add_argument("--tolerance", type=float, default=1e-9,
                    help="max |best_bid_A - (1 - best_ask_B)| at matching src_ts (default 1e-9)")
    ap.add_argument("--max-mismatch-rate", type=float, default=0.01,
                    help="fail (exit 1) if mismatched/checked exceeds this (default 0.01)")
    args = ap.parse_args()

    if bool(args.hour) == bool(args.latest):
        die("pass exactly one of --hour or --latest")
    hour = args.hour if args.hour else latest_hour(args.dir)

    files = sorted(glob.glob(os.path.join(args.dir, f"pm-book-{hour}*.jsonl.gz")))
    if not files:
        die(f"no pm-book files for hour {hour} under {args.dir}")

    # (market, src_ts) -> {token_id: (best_bid, best_ask)}
    groups: dict = {}
    rows = bad_rows = 0
    for path in files:
        try:
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    rows += 1
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        bad_rows += 1
                        continue
                    bb, ba, flat = best_prices(row)
                    market = first_key(flat, "market", "condition_id", "market_id")
                    token = first_key(flat, "asset_id", "token_id", "asset")
                    src_ts = flat.get("src_ts")
                    if market is None or token is None or src_ts is None:
                        bad_rows += 1
                        continue
                    if bb is None and ba is None:
                        bad_rows += 1
                        continue
                    # Last write wins within an identical (market, src_ts) key.
                    groups.setdefault((str(market), str(src_ts)), {})[str(token)] = (bb, ba)
        except (OSError, EOFError) as e:
            # A truncated in-progress gzip (current hour) is expected; count
            # what we could read and move on.
            print(f"  warn: {os.path.basename(path)}: {e} (partial read)", file=sys.stderr)

    checked = mismatched = 0
    worst = 0.0
    worst_key = None
    for key, tokens in groups.items():
        if len(tokens) != 2:
            continue
        (bb1, ba1), (bb2, ba2) = tokens.values()
        devs = []
        if bb1 is not None and ba2 is not None:
            devs.append(abs(bb1 - (1.0 - ba2)))
        if bb2 is not None and ba1 is not None:
            devs.append(abs(bb2 - (1.0 - ba1)))
        if not devs:
            continue
        checked += 1
        dev = max(devs)
        if dev > worst:
            worst, worst_key = dev, key
        if dev > args.tolerance:
            mismatched += 1

    rate = (mismatched / checked) if checked else float("nan")
    print(f"hour:            {hour}")
    print(f"files:           {len(files)}")
    print(f"rows read:       {rows} (unparseable/incomplete: {bad_rows})")
    print(f"pairs checked:   {checked}")
    print(f"pairs mismatched:{mismatched}")
    print(f"mismatch rate:   {rate:.6%}" if checked else "mismatch rate:   n/a (no pairs)")
    print(f"worst deviation: {worst:.3e}" + (f" at (market,src_ts)={worst_key}" if worst_key else ""))

    if checked == 0:
        print("FAIL — no comparable two-token pairs found (cannot assert mirror consistency)")
        return 1
    if rate > args.max_mismatch_rate:
        print(f"FAIL — mismatch rate {rate:.4%} > {args.max_mismatch_rate:.2%}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
