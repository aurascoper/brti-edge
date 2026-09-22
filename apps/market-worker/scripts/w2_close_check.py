#!/usr/bin/env python3
"""W2/W2′ mechanical close protocol — the ONLY sanctioned way to read a gate line.

Implements annex §5 (w2-evidence-annex-and-close-protocol.md) closing audit
F2/F20 and arming F1/F5:

  1. G4  — eligibility computed over the exact span: shadow-log continuity AND
           collector hour-file coverage (worst channel), bars per prereg §4:
           worst-channel coverage >= 99%, no continuous gap > 1h. W2″ amendment
           (precommit §6): both are measured in EXCHANGE-OPEN time. The only
           time removed is a no-market interval in the settled listing that lies
           inside a published Thursday pause (03:00–05:00 ET) padded by one
           market. It is compressed out, not masked: a fault on either side of
           the pause joins into one gap.
  2. F1  — settlement reconciliation: fetches the EXCHANGE's settled KXBTC15M
           listing for the span (one fetch; also the fire-coverage denominator)
           and reconciles against kalshi-settlement-validation.jsonl.
  3. G5  — freeze integrity: git diff of frozen paths against the instrument
           tag; env attestation from worker startup lines; calibration.json
           must be ABSENT (§12 freeze rider, audit F7). W2″: the running
           worker's own /proc environ must show the three order gates at 0,
           none of the five decision knobs, and feed endpoints equal to the
           env vector committed at lock (--env-vector).
  4. Only if 1–3 pass is the scorer invoked (with --settled-listing so the §4
     fire-coverage tripwire is armed). The NO-GO quadrant is named from the
     printed gates. In --interim mode a 1–3 failure prints the failure class,
     never a bare GO.

Read-only apart from writing the fetched listing under analysis/w2/.

Usage:
  python3 scripts/w2_close_check.py --since <ISO> --until <ISO> \
      [--interim] [--tag w2-scorer-final-20260803] [--offline-listing FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.normpath(os.path.join(HERE, ".."))
REPO = os.path.normpath(os.path.join(WORKER, "..", ".."))
LOGS = os.path.join(WORKER, "logs")
COLLECTOR_LOGS = os.path.join(REPO, "apps", "data-collector", "logs", "data-collector")
ANALYSIS_W2 = os.path.join(REPO, "analysis", "w2")
API_BASE_DEFAULT = "https://api.elections.kalshi.com/trade-api/v2"
API_BASE = os.environ.get("KALSHI_API_BASE", API_BASE_DEFAULT)

MIN_WORST_COVERAGE = 0.99   # §4 / holdout policy — policy, not tunable
MAX_GAP_HOURS = 1.0         # §4 continuous-gap rule — policy, not tunable
FIRE_COVERAGE_TRIPWIRE = 0.02
CHANNELS = ("orderbook-snapshots", "orderbook-deltas")
FROZEN_PATHS = (
    "apps/market-worker/src",
    "apps/market-worker/scripts/w2_replay_scorer.py",
    "apps/market-worker/scripts/w2_close_check.py",  # W2″: the wrapper is frozen too
    "apps/market-worker/scripts/w2pp-env-vector.json",  # W2″: G5 compares workers to it
    "packages/kalshi-client/src",
    "packages/signals/src",
)
WORKER_CMD = b"src/kalshi/worker.ts"
ORDER_GATES = ("KALSHI_ALLOW_ORDERS", "KALSHI_AUTO_SUBMIT", "KALSHI_DUST_ENABLED")
KNOBS = ("KALSHI_SIGMA_MULTIPLIER", "KALSHI_MIN_Z_DISTANCE", "KALSHI_CALIBRATION_ALPHA",
         "KALSHI_SPOT_MAX_AGE_MS", "KALSHI_SCAN_INTERVAL_MS")  # must stay at code defaults
# The API base is in the vector too: the worker and this listing fetch both read it,
# so a wrong endpoint would otherwise agree with itself.
ENV_VECTOR_KEYS = ("KALSHI_API_BASE", "SPOT_FEED_REST", "PERP_FEED_REST", "PERP_FEED_PATH")
LISTING_PAD_MS = 3 * 3_600_000  # anchors a pause at the start edge; see §12 boundary rule
MARKET_MS = 15 * 60_000     # one KXBTC15M market; pads the published pause
ET = ZoneInfo("America/New_York")
PAUSE_ET_HOURS = (3, 5)     # Kalshi weekly maintenance, Thursday 03:00–05:00 ET


def ts_ms(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def iso_utc(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


# ---------- 1. G4 eligibility (exchange-open time) ----------

def published_pauses(t0: float, t1: float):
    """Published Thursday pauses overlapping [t0, t1], in UTC ms, padded by one
    market each side. Computed in ET, so the UTC hours follow DST."""
    out = []
    day = datetime.fromtimestamp(t0 / 1000, tz=ET).date() - timedelta(days=1)
    last = datetime.fromtimestamp(t1 / 1000, tz=ET).date() + timedelta(days=1)
    while day <= last:
        if day.weekday() == 3:  # Thursday
            a, b = (datetime(day.year, day.month, day.day, h, tzinfo=ET).timestamp() * 1000
                    for h in PAUSE_ET_HOURS)
            out.append((a - MARKET_MS, b + MARKET_MS))
        day += timedelta(days=1)
    return out


def excluded_intervals(listing, t0: float, t1: float):
    """No-market intervals from the exchange's settled listing: between a close
    and the next close, no market is open until that next market's open
    (close − one market). Only the part that overlaps a padded published pause
    is excluded. An exchange overrun past the pad stays a counted gap, and no
    time with an open market is ever excluded."""
    closes = sorted({ts_ms(m["close_time"]) for m in listing if m.get("close_time")})
    pauses = published_pauses(t0, t1)
    out = []
    for prev, nxt in zip(closes, closes[1:]):
        for p0, p1 in pauses:
            lo, hi = max(prev, p0, t0), min(nxt - MARKET_MS, p1, t1)
            if hi > lo:
                out.append((lo, hi))
    return out


def open_ms(t: float, excluded) -> float:
    """Wall clock → exchange-open clock: removes excluded time before t. A time
    inside an excluded interval maps to the interval's start, so the gap across
    a pause is its open-time length (compression, not masking)."""
    return t - sum(min(max(t - a, 0), b - a) for a, b in excluded)


def shadow_gaps(ts, t0: float, t1: float, excluded):
    bounds = [t0] + sorted(ts) + [t1]
    gaps = []
    for a, b in zip(bounds, bounds[1:]):
        d = open_ms(b, excluded) - open_ms(a, excluded)
        if d > 60_000:  # ignore sub-minute jitter
            gaps.append((a, b, d))
    max_gap_h = max((d / 3_600_000 for _, _, d in gaps), default=0.0)
    lost_h = sum(d / 3_600_000 for _, _, d in gaps)
    span_h = (open_ms(t1, excluded) - open_ms(t0, excluded)) / 3_600_000
    coverage = (span_h - lost_h) / span_h if span_h > 0 else 0.0
    return {
        "ok": max_gap_h <= MAX_GAP_HOURS and coverage >= MIN_WORST_COVERAGE,
        "coverage": coverage, "max_gap_h": max_gap_h,
        "gaps": [(iso_utc(a), iso_utc(b)) for a, b, d in gaps if d > 600_000],
    }


def check_shadow_continuity(t0: float, t1: float, excluded):
    rows = load_jsonl(os.path.join(LOGS, "kalshi-shadow.jsonl"))
    ts = [ts_ms(r["ts"]) for r in rows if "ts" in r and t0 <= ts_ms(r["ts"]) <= t1]
    if not ts:
        return {"ok": False, "why": "no shadow rows in span"}
    return shadow_gaps(ts, t0, t1, excluded)


def check_collector_hours(t0: float, t1: float, excluded):
    # Hour-file presence per channel, .pN crash-relaunch parts included.
    try:
        files = os.listdir(COLLECTOR_LOGS)
    except FileNotFoundError:
        return {"ok": False, "why": f"collector log dir missing: {COLLECTOR_LOGS}"}
    have = {c: set() for c in CHANNELS}
    pat = re.compile(r"^(.+)-(\d{4}-\d{2}-\d{2}T\d{2})(?:\.p\d+)?\.jsonl\.gz$")
    for f in files:
        m = pat.match(f)
        if m and m.group(1) in have:
            have[m.group(1)].add(m.group(2))
    return collector_hours(have, t0, t1, excluded)


def collector_hours(have, t0: float, t1: float, excluded):
    # An hour wholly inside an excluded interval is not expected; dropping it
    # makes the hours on either side adjacent, so missing runs join across it.
    expected = []
    t = t0 - (t0 % 3_600_000)
    while t < t1:
        lo, hi = max(t, t0), min(t + 3_600_000, t1)
        if not any(a <= lo and hi <= b for a, b in excluded):
            expected.append(
                datetime.fromtimestamp(t / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H"))
        t += 3_600_000
    worst = 1.0
    worst_gap = 0
    per_channel = {}
    for c in CHANNELS:
        missing = [h for h in expected if h not in have[c]]
        cov = 1 - len(missing) / max(1, len(expected))
        run = best = 0
        for h in expected:
            run = run + 1 if h not in have[c] else 0
            best = max(best, run)
        per_channel[c] = {"coverage": cov, "max_missing_run_h": best, "missing": len(missing)}
        worst = min(worst, cov)
        worst_gap = max(worst_gap, best)
    return {
        "ok": worst >= MIN_WORST_COVERAGE and worst_gap <= MAX_GAP_HOURS,
        "worst_coverage": worst, "worst_gap_h": worst_gap, "channels": per_channel,
        "note": "hour-FILE presence; a partial hour still counts present (audit F6 residual)",
    }


# ---------- 2. exchange listing + reconciliation ----------

def fetch_settled_listing(t0: float, t1: float):
    results, cursor = [], None
    while True:
        q = {
            "series_ticker": "KXBTC15M", "status": "settled", "limit": "1000",
            "min_close_ts": str(int(t0 / 1000)), "max_close_ts": str(int(t1 / 1000)),
        }
        if cursor:
            q["cursor"] = cursor
        url = f"{API_BASE}/markets?{urllib.parse.urlencode(q)}"
        with urllib.request.urlopen(url, timeout=30) as resp:
            body = json.load(resp)
        for m in body.get("markets", []):
            results.append({"ticker": m.get("ticker"), "close_time": m.get("close_time"),
                            "result": m.get("result")})
        cursor = body.get("cursor")
        if not cursor or not body.get("markets"):
            break
    return results


def loosely_within(close_time, t0: float, t1: float) -> bool:
    """Window test for a row too malformed for the strict parse. A time with no
    zone reads as UTC; a time that will not parse cannot be placed, so it is not
    this window's to fail on."""
    try:
        dt = datetime.fromisoformat(str(close_time).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return t0 <= dt.timestamp() * 1000 <= t1


def reconcile(listing, t0: float, t1: float):
    problems = []

    def index(rows, result_key, source):
        grouped = {}
        for row in rows:
            ticker = row.get("ticker")
            if not isinstance(ticker, str) or not ticker.startswith("KXBTC15M-"):
                if source == "exchange":
                    problems.append("exchange: invalid ticker")
                continue
            # Pending local validation records are not settlement records.
            if source == "local" and row.get(result_key) in (None, ""):
                continue
            try:
                dt = datetime.fromisoformat(row["close_time"].replace("Z", "+00:00"))
                if dt.tzinfo is None or row.get(result_key) not in ("yes", "no"):
                    raise ValueError("invalid close or result")
                identity = (dt.timestamp() * 1000, row[result_key])
            except (KeyError, ValueError, TypeError, AttributeError, OverflowError):
                # The local file spans every window ever scored, so a malformed row
                # from an earlier one must not fail this window. The exchange listing
                # is already filtered to the span, so every bad row there counts.
                if source == "exchange" or loosely_within(row.get("close_time"), t0, t1):
                    problems.append(f"{source}: malformed settlement {ticker}")
                continue
            grouped.setdefault(ticker, set()).add(identity)
        result = {}
        for ticker, identities in grouped.items():
            if not any(t0 <= ct <= t1 for ct, _ in identities):
                continue
            if len(identities) != 1:
                problems.append(f"{source}: conflicting duplicate {ticker}")
                continue
            result[ticker] = next(iter(identities))
        return result

    local = index(load_jsonl(os.path.join(LOGS, "kalshi-settlement-validation.jsonl")),
                  "kalshi_result", "local")
    exchange = index(listing, "result", "exchange")
    ex, captured = set(exchange), set(local)
    conflicts = sorted(t for t in ex & captured if exchange[t] != local[t])
    missing, extra = sorted(ex - captured), sorted(captured - ex)
    return {"exchange": len(ex), "captured": len(captured & ex),
            "missing": missing, "extra_local": extra, "conflicts": conflicts,
            "problems": problems,
            "integrity_ok": bool(ex) and not extra and not conflicts and not problems}


# ---------- 3. G5 freeze ----------

def check_freeze(tag: str):
    diff = subprocess.run(
        ["git", "-C", REPO, "diff", "--stat", f"{tag}..HEAD", "--", *FROZEN_PATHS],
        capture_output=True, text=True)
    dirty = subprocess.run(
        ["git", "-C", REPO, "status", "--porcelain", "--", *FROZEN_PATHS],
        capture_output=True, text=True)
    calib = os.path.join(LOGS, "calibration.json")
    calib_ok = not os.path.exists(calib)
    env_line = None
    try:
        with open(os.path.join(LOGS, "launchd-kalshi-worker.out.log"), "rb") as f:
            for raw in f:  # stream; keep the LAST startup line in the file
                if b"starting; scan interval" in raw:
                    env_line = raw.decode(errors="replace").strip()
    except FileNotFoundError:
        pass
    env_ok = env_line is not None and "scan interval 15000ms" in env_line
    # A missing tag makes git exit 128 with empty stdout; that must never read as clean.
    git_ok = diff.returncode == 0 and dirty.returncode == 0
    return {
        "ok": git_ok and not diff.stdout.strip() and not dirty.stdout.strip() and calib_ok and env_ok,
        "git_ok": git_ok,
        "diff_vs_tag": (diff.stdout.strip() or "(clean)") if git_ok
                       else f"git failed: {(diff.stderr or dirty.stderr).strip()}",
        "working_tree": dirty.stdout.strip() or "(clean)",
        "calibration_json_absent": calib_ok,
        "env_attestation": env_line or "(no startup line found)",
    }


def worker_environs(proc: str = "/proc"):
    """Environment of each running Kalshi worker this user can read, by pid."""
    out = {}
    for pid in os.listdir(proc):
        if not pid.isdigit():
            continue
        try:
            with open(os.path.join(proc, pid, "cmdline"), "rb") as f:
                if WORKER_CMD not in f.read():
                    continue
            with open(os.path.join(proc, pid, "environ"), "rb") as f:
                raw = f.read()
        except OSError:
            continue
        out[int(pid)] = dict(
            kv.split("=", 1) for kv in raw.decode(errors="replace").split("\0") if "=" in kv)
    return out


def check_worker_env(environs, vector, wrapper_base=None):
    """G5 env (W2″): every running worker has the three order gates at 0, none of
    the five knobs set, and API/feed endpoints equal to the env vector fixed at
    lock; this wrapper's own listing endpoint must match the vector as well.
    No readable worker, or no vector, fails: an empty read must never pass."""
    if vector is None:
        return {"ok": False, "why": "no lock env vector given (--env-vector)"}
    if wrapper_base is not None and wrapper_base != vector.get("KALSHI_API_BASE", API_BASE_DEFAULT):
        return {"ok": False, "why": f"wrapper listing endpoint {wrapper_base} != lock vector"}
    if not environs:
        return {"ok": False, "why": "no readable kalshi worker process"}
    problems = []
    for pid, env in sorted(environs.items()):
        problems += [f"{pid}: {g}={env.get(g)!r}" for g in ORDER_GATES if env.get(g) != "0"]
        problems += [f"{pid}: {k} is set" for k in KNOBS if k in env]
        endpoints = {k: env[k] for k in ENV_VECTOR_KEYS if k in env}
        if endpoints != vector:
            problems.append(f"{pid}: endpoints {endpoints} != lock vector {vector}")
    return {"ok": not problems, "pids": sorted(environs), "problems": problems}


def verdict(returncode: int, stdout: str, interim: bool):
    """The printed verdict and exit code for one scorer run. Fails closed: a
    failed scorer or a missing gate line is NO-GO (integrity), and a tripped §4
    tripwire is NO-GO (data) (prereg §8). The scorer enforces the tripwire itself
    only under --interim; in final mode it only prints it."""
    if returncode != 0:
        return ("NO-GO (integrity)" if interim else
                f"\nVERDICT: NO-GO (integrity) — scorer exited {returncode}"), 1
    lines = stdout.strip().splitlines()
    if interim:
        return (lines[0], 0) if len(lines) == 1 and lines[0] in ("GO", "CONTINUE") \
            else ("NO-GO (integrity)", 1)
    if "TRIPWIRE" in stdout:
        return "\nVERDICT: NO-GO (data) — §4 tripwire tripped; window suspect", 1
    gate_lines = re.findall(r"^\s*gates: ([^\n]*)$", stdout, re.MULTILINE)  # the scorer's own space
    malformed = "\nVERDICT: NO-GO (integrity) — malformed or incomplete gate output"
    if len(gate_lines) != 1:
        return malformed, 1
    # Match the scorer's exact optional final-bound annotation, never free text.
    body = re.sub(r"\s*\[G2 bound z≥1\.7\]\s*$", "", gate_lines[0]).strip()
    tokens = body.split()
    matches = [re.fullmatch(r"(G[12367])\((PASS|FAIL)\)", token) for token in tokens]
    expected = {"G1", "G2", "G3", "G6", "G7"}
    if len(matches) != len(expected) or any(m is None for m in matches):
        return malformed, 1
    if {m[1] for m in matches} != expected:
        return malformed, 1
    failed = [m[1] for m in matches if m[2] == "FAIL"]
    if not failed:
        return "\nVERDICT: GO — full battery PASS on an eligible, frozen window", 0
    if set(failed) & {"G7"}:
        return f"\nVERDICT: NO-GO (mechanism) — failed: {', '.join(failed)}", 0
    if set(failed) & {"G3"}:
        return f"\nVERDICT: NO-GO (execution) — failed: {', '.join(failed)}", 0
    return (f"\nVERDICT: NO-GO (economics) — failed: {', '.join(failed)}"
            "\n  (annex §3 erratum: at se ≈ 48¢/√n this is NOT evidence of no edge)"), 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    ap.add_argument("--interim", action="store_true")
    ap.add_argument("--tag", default="w2-scorer-final-20260803")
    ap.add_argument("--offline-listing", default=None,
                    help="use a previously fetched listing JSON instead of hitting the API")
    ap.add_argument("--env-vector", default=None,
                    help="feed-endpoint JSON committed at lock; G5 compares the running worker to it")
    args = ap.parse_args()
    t0, t1 = ts_ms(args.since), ts_ms(args.until)
    quiet = args.interim
    say = (lambda *a: None) if quiet else print

    say(f"# W2 close protocol — {args.since} -> {args.until}  (tag {args.tag})")

    # The listing comes first: G4's excluded intervals are derived from it. The fetch
    # is padded so a pause that straddles t0 is anchored by closes on both sides. At a
    # live close no market after t1 has settled, so the pad cannot anchor t1; the §12
    # window boundary rule keeps t1 out of the pause. Reconciliation and the scorer
    # keep the exact span.
    if args.offline_listing:
        with open(args.offline_listing) as f:
            anchor = json.load(f)
    else:
        try:
            anchor = fetch_settled_listing(t0 - LISTING_PAD_MS, t1 + LISTING_PAD_MS)
        except Exception as e:  # noqa: BLE001 — a failed fetch must fail the window, loudly
            print(f"NO-GO (data)" if args.interim else f"  exchange fetch FAILED: {e}")
            return 2
    listing = [m for m in anchor if m.get("close_time") and t0 <= ts_ms(m["close_time"]) <= t1]
    os.makedirs(ANALYSIS_W2, exist_ok=True)
    listing_path = os.path.join(
        ANALYSIS_W2, f"settled-listing-{args.since[:10]}-{args.until[:10]}.json")
    with open(listing_path, "w") as f:
        json.dump(listing, f, indent=1)

    excluded = excluded_intervals(anchor, t0, t1)
    shadow = check_shadow_continuity(t0, t1, excluded)
    hours = check_collector_hours(t0, t1, excluded)
    say(f"\n[1] G4 eligibility (exchange-open time)")
    for a, b in excluded:
        say(f"  excluded (published pause, from listing): {iso_utc(a)} -> {iso_utc(b)}")
    say(f"  shadow: coverage {shadow.get('coverage', 0) * 100:.2f}%  max gap "
        f"{shadow.get('max_gap_h', 0):.2f}h  -> {'PASS' if shadow['ok'] else 'FAIL'}")
    for a, b in shadow.get("gaps", []):
        say(f"    gap {a} -> {b}")
    say(f"  collector: worst-channel {hours.get('worst_coverage', 0) * 100:.2f}%  "
        f"max missing run {hours.get('worst_gap_h', 0)}h  -> {'PASS' if hours['ok'] else 'FAIL'}")
    g4_ok = shadow["ok"] and hours["ok"]

    rec = reconcile(listing, t0, t1)
    say(f"\n[2] settlement reconciliation (F1)")
    say(f"  exchange settled: {rec['exchange']}  captured locally: {rec['captured']}  "
        f"missing: {len(rec['missing'])}  extra-local: {len(rec['extra_local'])}")
    if rec["missing"]:
        say(f"    missing: {', '.join(rec['missing'][:10])}"
            + (f" … +{len(rec['missing']) - 10}" if len(rec['missing']) > 10 else ""))
    rec_rate = len(rec["missing"]) / max(1, rec["exchange"])
    rec_ok = rec["integrity_ok"] and rec_rate <= FIRE_COVERAGE_TRIPWIRE
    for problem in rec["problems"]:
        say(f"    {problem}")
    for ticker in rec["conflicts"]:
        say(f"    settlement outcome/close mismatch: {ticker}")
    if not rec["exchange"]:
        say("    empty exchange settlement listing")

    fz = check_freeze(args.tag)
    vector = None
    if args.env_vector:
        with open(args.env_vector) as f:
            vector = json.load(f)
    wenv = check_worker_env(worker_environs(), vector, API_BASE)
    fz["ok"] = fz["ok"] and wenv["ok"]
    say(f"\n[3] G5 freeze integrity -> {'PASS' if fz['ok'] else 'FAIL'}")
    say(f"  worker env: pids {wenv.get('pids', [])} -> {'PASS' if wenv['ok'] else 'FAIL'}"
        + (f" ({wenv['why']})" if "why" in wenv else ""))
    for p in wenv.get("problems", []):
        say(f"    {p}")
    say(f"  diff vs {args.tag}: {fz['diff_vs_tag']}")
    say(f"  working tree: {fz['working_tree']}")
    say(f"  calibration.json absent: {fz['calibration_json_absent']}")
    say(f"  env: {fz['env_attestation']}")

    if not g4_ok or not rec_ok:
        print("NO-GO (data)" if args.interim
              else "\nVERDICT: NO-GO (data) — window ineligible (§4); scorer not consulted")
        return 1
    if not fz["ok"]:
        print("NO-GO (integrity)" if args.interim
              else "\nVERDICT: NO-GO (integrity) — freeze violated (§6); scorer not consulted")
        return 1

    say(f"\n[4] scorer (fire-coverage armed via {os.path.basename(listing_path)})")
    cmd = [sys.executable, os.path.join(HERE, "w2_replay_scorer.py"),
           "--since", args.since, "--until", args.until,
           "--settled-listing", listing_path]
    if args.interim:
        cmd.append("--interim")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if not args.interim:
        print(proc.stdout, end="")
        if proc.returncode:
            print(proc.stderr, end="")
    line, code = verdict(proc.returncode, proc.stdout, args.interim)
    print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
