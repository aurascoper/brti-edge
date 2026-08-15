#!/usr/bin/env python3
# =============================================================================
# OpenMarket corpus -> polyterminal pm-book / spot-trades JSONL converter
# =============================================================================
# BOOTSTRAP ONLY — data produced by this script is ineligible for any Phase-3
# scoring window. Every emitted row is stamped
#   {"provenance": {"source": "openmarket-v0.5.2", "bootstrap_only": true}}
# so downstream eligibility checks can (and must) exclude it.
#
# Maps two OpenMarket configs onto this archiver's gzip JSONL schema
# (src/persistence.ts naming: <channel>-<YYYY-MM-DDTHH>.jsonl.gz):
#   polymarket_ticks_ms  ->  pm-book      (level-1 quotes)
#   binance_trades       ->  spot-trades
#
# Historical caveat: the live archiver stamps ingest_ts = Date.now() at
# capture time. For converted historical rows there is no capture wall-clock,
# so ingest_ts mirrors src_ts (replay ordering stays correct); bootstrap_only
# marks the difference.
#
# DEPENDENCIES: stdlib only for --sample discovery/download and for --sanity.
# Parsing parquet requires pyarrow. For the FULL corpus pull, use a venv:
#     python3 -m venv .venv && . .venv/bin/activate
#     pip install datasets pyarrow
#     # then download the configs locally and point --input at the parquet dir
#
# Usage:
#   # local parquet mode (pyarrow required):
#   python3 scripts/convert_openmarket_corpus.py \
#       --input /path/to/openmarket/parquet --out logs/openmarket-bootstrap
#
#   # small-sample mode: discovers + downloads the v0.1-sample split parquet
#   # over plain HTTPS (stdlib urllib, no `datasets` lib); parsing the
#   # downloaded parquet still requires pyarrow:
#   python3 scripts/convert_openmarket_corpus.py \
#       --sample --repo <hf-dataset-id> --out logs/openmarket-bootstrap
#
#   # sanity check on ALREADY-CONVERTED output (stdlib only). Targets from
#   # the OpenMarket paper: 347 ms median quote-response lag, 91.9%
#   # one-tick-spread share:
#   python3 scripts/convert_openmarket_corpus.py --sanity logs/openmarket-bootstrap
# =============================================================================

import argparse
import bisect
import glob
import gzip
import json
import os
import statistics
import sys
import urllib.request
from datetime import datetime, timezone

PROVENANCE = {"source": "openmarket-v0.5.2", "bootstrap_only": True}
TICKS_CONFIG = "polymarket_ticks_ms"
TRADES_CONFIG = "binance_trades"

# Candidate column names per logical field — OpenMarket column naming varies
# across corpus versions; we resolve against what the parquet actually has and
# fail loudly (listing the real columns) if a required field is absent.
TICKS_COLS = {
    "ts": ["ts_ms", "ts", "timestamp_ms", "timestamp", "time_ms", "time"],
    "market": ["market", "condition_id", "market_id", "market_slug"],
    "token": ["token_id", "asset_id", "token", "outcome_token"],
    "best_bid": ["best_bid", "bid", "bid_price", "bb"],
    "best_ask": ["best_ask", "ask", "ask_price", "ba"],
    "bid_size": ["bid_size", "best_bid_size", "bid_qty"],   # optional
    "ask_size": ["ask_size", "best_ask_size", "ask_qty"],   # optional
}
TRADES_COLS = {
    "ts": ["ts_ms", "ts", "timestamp_ms", "timestamp", "trade_time", "time"],
    "price": ["price", "p"],
    "size": ["qty", "quantity", "size", "q", "amount"],
    "symbol": ["symbol", "pair", "instrument"],             # optional
    "side": ["side", "is_buyer_maker", "taker_side"],       # optional
}


def die(msg, code=2):
    print(f"convert_openmarket_corpus: {msg}", file=sys.stderr)
    sys.exit(code)


def epoch_ms(v):
    v = float(v)
    if v > 1e14:            # microseconds
        return v / 1000.0
    if v > 1e11:            # already ms
        return v
    return v * 1000.0       # seconds


def hour_key(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H")


class HourlyGzipWriter:
    """Mirrors src/persistence.ts naming: <channel>-<hour>.jsonl.gz.

    NEVER appends (persistence.ts contract: hour files are single-writer).
    A rerun into an --out dir that already holds converted files for this
    channel is a hard error — appending would silently duplicate the tape and
    poison --sanity stats. Unsorted input that re-crosses an hour boundary
    within a run rotates to a fresh .pN part, matching the live rotator.
    """

    def __init__(self, out_dir, channel):
        self.out_dir, self.channel = out_dir, channel
        self.hour, self.fh, self.lines = None, None, 0
        self.parts = {}  # hour -> number of files already opened this run
        os.makedirs(out_dir, exist_ok=True)
        stale = sorted(glob.glob(os.path.join(out_dir, f"{channel}-*.jsonl.gz")))
        if stale:
            die(f"--out already contains {len(stale)} converted {channel} file(s) "
                f"(e.g. {os.path.basename(stale[0])}); rerunning would duplicate the "
                "tape — remove the converted *.jsonl.gz files (raw-sample/ can stay) "
                "and rerun")

    def write(self, row):
        hk = hour_key(row["src_ts"])
        if hk != self.hour:
            self.close()
            self.hour = hk
            part = self.parts.get(hk, 0)
            self.parts[hk] = part + 1
            name = (f"{self.channel}-{hk}.jsonl.gz" if part == 0
                    else f"{self.channel}-{hk}.p{part + 1}.jsonl.gz")
            # "x" (exclusive create): appending to an existing gzip is never OK.
            self.fh = gzip.open(os.path.join(self.out_dir, name), "xt")
        self.fh.write(json.dumps(row, separators=(",", ":")) + "\n")
        self.lines += 1

    def close(self):
        if self.fh:
            self.fh.close()
            self.fh = None


def resolve_cols(available, spec, required):
    cols, missing = {}, []
    lower = {c.lower(): c for c in available}
    for field, cands in spec.items():
        hit = next((lower[c] for c in cands if c in lower), None)
        if hit is None and field in required:
            missing.append(field)
        cols[field] = hit
    if missing:
        die(f"cannot find columns for {missing}; parquet has: {sorted(available)}")
    return cols


def load_pyarrow():
    try:
        import pyarrow.parquet as pq  # noqa: F401
        return pq
    except ImportError:
        die("pyarrow is required to parse parquet. Install in a venv: "
            "python3 -m venv .venv && . .venv/bin/activate && pip install datasets pyarrow")


def classify(path):
    base = os.path.basename(path).lower()
    if "polymarket" in base or "tick" in base:
        return TICKS_CONFIG
    if "binance" in base or "trade" in base:
        return TRADES_CONFIG
    return None


def convert_ticks(pq, path, writer):
    table = pq.read_table(path)
    cols = resolve_cols(table.column_names, TICKS_COLS, {"ts", "token", "best_bid", "best_ask"})
    data = {f: (table.column(c).to_pylist() if c else None) for f, c in cols.items()}
    n = table.num_rows
    for i in range(n):
        ts = epoch_ms(data["ts"][i])
        row = {
            "src_ts": ts,
            "ingest_ts": ts,  # historical: no capture wall-clock (see header)
            "market": data["market"][i] if data["market"] else None,
            "asset_id": data["token"][i],
            "best_bid": float(data["best_bid"][i]),
            "best_ask": float(data["best_ask"][i]),
            "provenance": PROVENANCE,
        }
        if data["bid_size"] is not None:
            row["bid_size"] = float(data["bid_size"][i])
        if data["ask_size"] is not None:
            row["ask_size"] = float(data["ask_size"][i])
        writer.write(row)
    return n


def convert_trades(pq, path, writer):
    table = pq.read_table(path)
    cols = resolve_cols(table.column_names, TRADES_COLS, {"ts", "price", "size"})
    data = {f: (table.column(c).to_pylist() if c else None) for f, c in cols.items()}
    n = table.num_rows
    for i in range(n):
        ts = epoch_ms(data["ts"][i])
        row = {
            "src_ts": ts,
            "ingest_ts": ts,  # historical: no capture wall-clock (see header)
            "symbol": data["symbol"][i] if data["symbol"] else None,
            "price": float(data["price"][i]),
            "size": float(data["size"][i]),
            "provenance": PROVENANCE,
        }
        if data["side"] is not None:
            row["side"] = data["side"][i]
        writer.write(row)
    return n


def fetch_sample(repo, out_dir):
    """Discover + download the sample split's parquet shards over plain HTTPS
    (stdlib only, no `datasets` lib). Hugging Face exposes auto-converted
    parquet at /api/datasets/<repo>/parquet as {config: {split: [urls]}}."""
    api = f"https://huggingface.co/api/datasets/{repo}/parquet"
    try:
        with urllib.request.urlopen(api, timeout=60) as resp:
            listing = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        die(f"could not enumerate parquet for '{repo}' via {api}: {e}\n"
            "Fallback: download the parquet files manually (browser or "
            "`pip install datasets` in a venv) and rerun with --input <dir>.")
    raw_dir = os.path.join(out_dir, "raw-sample")
    os.makedirs(raw_dir, exist_ok=True)
    fetched = []
    for config in (TICKS_CONFIG, TRADES_CONFIG):
        splits = listing.get(config)
        if not splits:
            print(f"  warn: config '{config}' not in listing "
                  f"(available: {sorted(listing)})", file=sys.stderr)
            continue
        # Prefer a split whose name mentions 'sample' (the v0.1-sample cut).
        split = next((s for s in splits if "sample" in s.lower()), sorted(splits)[0])
        for url in splits[split]:
            dest = os.path.join(raw_dir, f"{config}--{split}--{os.path.basename(url)}")
            if not os.path.exists(dest):
                print(f"  fetching {url}")
                urllib.request.urlretrieve(url, dest)
            fetched.append(dest)
    if not fetched:
        die(f"no parquet shards found for configs {TICKS_CONFIG}/{TRADES_CONFIG} in '{repo}'")
    return fetched


# ---------------------------------------------------------------------------
# --sanity: reproduce the OpenMarket paper's headline numbers on CONVERTED
# output. Targets: 347 ms median quote-response lag (Binance price-moving
# trade -> next Polymarket quote change) and 91.9% one-tick-spread share.
# ---------------------------------------------------------------------------
def load_converted(paths, channel):
    rows = []
    for path in paths:
        if f"{channel}-" not in os.path.basename(path):
            continue
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    rows.sort(key=lambda r: r["src_ts"])
    return rows


def sanity(paths, tick=None, max_lag_ms=5000.0):
    books = load_converted(paths, "pm-book")
    trades = load_converted(paths, "spot-trades")
    if not books or not trades:
        die(f"--sanity needs both pm-book and spot-trades converted files "
            f"(found {len(books)} book rows, {len(trades)} trade rows)")

    # Quote-change timestamps: per token, a row whose (bb, ba) differs from
    # that token's previous row.
    last_quote, changes = {}, []
    spreads = []
    for r in books:
        bb, ba = r.get("best_bid"), r.get("best_ask")
        if bb is None or ba is None:
            continue
        spreads.append(ba - bb)
        tok = r.get("asset_id")
        if last_quote.get(tok) != (bb, ba):
            last_quote[tok] = (bb, ba)
            changes.append(r["src_ts"])
    changes.sort()

    # Price-moving Binance trades -> lag to next quote change.
    lags, last_px = [], None
    for t in trades:
        px = t.get("price")
        if px is None:
            continue
        if last_px is not None and px != last_px:
            i = bisect.bisect_left(changes, t["src_ts"])
            if i < len(changes):
                lag = changes[i] - t["src_ts"]
                if lag <= max_lag_ms:
                    lags.append(lag)
        last_px = px

    med = statistics.median(lags) if lags else float("nan")
    pos = [s for s in spreads if s > 1e-12]
    if tick is None:
        tick = min(pos) if pos else float("nan")
    one_tick = sum(1 for s in pos if abs(s / tick - 1.0) < 0.25)
    share = 100.0 * one_tick / len(pos) if pos else float("nan")

    print(f"book rows: {len(books)}  trade rows: {len(trades)}  quote changes: {len(changes)}")
    print(f"median quote-response lag: {med:.1f} ms   (paper target: 347 ms)")
    print(f"one-tick-spread share:     {share:.1f}% (tick={tick})   (paper target: 91.9%)")
    ok = (abs(med - 347.0) <= 100.0) and (abs(share - 91.9) <= 5.0)
    print("SANITY " + ("PASS" if ok else "DIVERGENT — inspect conversion before any bootstrap use"))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="OpenMarket -> pm-book/spot-trades converter (BOOTSTRAP ONLY)")
    ap.add_argument("--input", help="dir (or single file) of locally downloaded OpenMarket parquet")
    ap.add_argument("--sample", action="store_true",
                    help="fetch the small sample split over HTTPS (stdlib) then convert (pyarrow needed)")
    ap.add_argument("--repo", default="openmarket/openmarket",
                    help="HF dataset id for --sample (default openmarket/openmarket; "
                    "override with the id shown on the dataset page)")
    ap.add_argument("--out", default=None, help="output dir for converted gzip JSONL")
    ap.add_argument("--sanity", nargs="+", metavar="PATH",
                    help="converted .jsonl.gz files or dirs — compute paper sanity numbers and exit")
    ap.add_argument("--tick", type=float, default=None, help="tick size for --sanity (default: min positive spread)")
    args = ap.parse_args()

    if args.sanity:
        paths = []
        for p in args.sanity:
            paths.extend(sorted(glob.glob(os.path.join(p, "*.jsonl.gz"))) if os.path.isdir(p) else [p])
        sys.exit(sanity(paths, tick=args.tick))

    if bool(args.input) == bool(args.sample):
        die("pass exactly one of --input or --sample (or use --sanity)")
    if not args.out:
        die("--out is required for conversion")

    if args.sample:
        parquets = fetch_sample(args.repo, args.out)
    else:
        parquets = sorted(glob.glob(os.path.join(args.input, "**", "*.parquet"), recursive=True)) \
            if os.path.isdir(args.input) else [args.input]
    if not parquets:
        die(f"no .parquet files under {args.input}")

    pq = load_pyarrow()
    book_w = HourlyGzipWriter(args.out, "pm-book")
    trade_w = HourlyGzipWriter(args.out, "spot-trades")
    n_ticks = n_trades = 0
    for path in parquets:
        kind = classify(path)
        if kind == TICKS_CONFIG:
            n_ticks += convert_ticks(pq, path, book_w)
        elif kind == TRADES_CONFIG:
            n_trades += convert_trades(pq, path, trade_w)
        else:
            print(f"  skip (cannot classify as ticks/trades from filename): {path}", file=sys.stderr)
    book_w.close()
    trade_w.close()
    print(f"converted: {n_ticks} tick rows -> pm-book, {n_trades} trade rows -> spot-trades, out={args.out}")
    print("REMINDER: bootstrap_only=true — ineligible for any Phase-3 scoring window.")
    print(f"Sanity-check with: python3 {sys.argv[0]} --sanity {args.out}")


if __name__ == "__main__":
    main()
