#!/usr/bin/env python3
"""W2/W2′ mechanical close protocol — the ONLY sanctioned way to read a gate line.

Implements annex §5 (w2-evidence-annex-and-close-protocol.md) closing audit
F2/F20 and arming F1/F5:

  1. G4  — eligibility computed over the exact span: shadow-log continuity AND
           collector hour-file coverage (worst channel), bars per prereg §4:
           worst-channel coverage >= 99%, no continuous gap > 1h.
  2. F1  — settlement reconciliation: fetches the EXCHANGE's settled KXBTC15M
           listing for the span (one fetch; also the fire-coverage denominator)
           and reconciles against kalshi-settlement-validation.jsonl.
  3. G5  — freeze integrity: git diff of frozen paths against the instrument
           tag; env attestation from worker startup lines; calibration.json
           must be ABSENT (§12 freeze rider, audit F7).
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
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.normpath(os.path.join(HERE, ".."))
REPO = os.path.normpath(os.path.join(WORKER, "..", ".."))
LOGS = os.path.join(WORKER, "logs")
COLLECTOR_LOGS = os.path.join(REPO, "apps", "data-collector", "logs", "data-collector")
ANALYSIS_W2 = os.path.join(REPO, "analysis", "w2")
API_BASE = os.environ.get("KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2")

MIN_WORST_COVERAGE = 0.99   # §4 / holdout policy — policy, not tunable
MAX_GAP_HOURS = 1.0         # §4 continuous-gap rule — policy, not tunable
FIRE_COVERAGE_TRIPWIRE = 0.02
CHANNELS = ("orderbook-snapshots", "orderbook-deltas")
FROZEN_PATHS = (
    "apps/market-worker/src",
    "apps/market-worker/scripts/w2_replay_scorer.py",
    "packages/kalshi-client/src",
    "packages/signals/src",
)


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


# ---------- 1. G4 eligibility ----------

def check_shadow_continuity(t0: float, t1: float):
    rows = load_jsonl(os.path.join(LOGS, "kalshi-shadow.jsonl"))
    ts = sorted(ts_ms(r["ts"]) for r in rows if "ts" in r and t0 <= ts_ms(r["ts"]) <= t1)
    if not ts:
        return {"ok": False, "why": "no shadow rows in span"}
    gaps = []
    bounds = [t0] + ts + [t1]
    for a, b in zip(bounds, bounds[1:]):
        if b - a > 60_000:  # ignore sub-minute jitter
            gaps.append((a, b))
    max_gap_h = max(((b - a) / 3_600_000 for a, b in gaps), default=0.0)
    lost_h = sum((b - a) / 3_600_000 for a, b in gaps)
    span_h = (t1 - t0) / 3_600_000
    coverage = (span_h - lost_h) / span_h if span_h > 0 else 0.0
    return {
        "ok": max_gap_h <= MAX_GAP_HOURS and coverage >= MIN_WORST_COVERAGE,
        "coverage": coverage, "max_gap_h": max_gap_h,
        "gaps": [(iso_utc(a), iso_utc(b)) for a, b in gaps if b - a > 600_000],
    }


def check_collector_hours(t0: float, t1: float):
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
    expected = []
    t = t0 - (t0 % 3_600_000)
    while t < t1:
        expected.append(datetime.fromtimestamp(t / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H"))
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


def reconcile(listing, t0: float, t1: float):
    captured = set()
    for r in load_jsonl(os.path.join(LOGS, "kalshi-settlement-validation.jsonl")):
        if r.get("kalshi_result") in ("yes", "no") and r.get("close_time") \
                and str(r.get("ticker", "")).startswith("KXBTC15M"):
            ct = ts_ms(r["close_time"])
            if t0 <= ct <= t1:
                captured.add(r["ticker"])
    ex = {m["ticker"] for m in listing if m.get("ticker")}
    missing = sorted(ex - captured)
    extra = sorted(captured - ex)
    return {"exchange": len(ex), "captured": len(captured & ex),
            "missing": missing, "extra_local": extra}


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
    return {
        "ok": not diff.stdout.strip() and not dirty.stdout.strip() and calib_ok and env_ok,
        "diff_vs_tag": diff.stdout.strip() or "(clean)",
        "working_tree": dirty.stdout.strip() or "(clean)",
        "calibration_json_absent": calib_ok,
        "env_attestation": env_line or "(no startup line found)",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    ap.add_argument("--interim", action="store_true")
    ap.add_argument("--tag", default="w2-scorer-final-20260803")
    ap.add_argument("--offline-listing", default=None,
                    help="use a previously fetched listing JSON instead of hitting the API")
    args = ap.parse_args()
    t0, t1 = ts_ms(args.since), ts_ms(args.until)
    quiet = args.interim
    say = (lambda *a: None) if quiet else print

    say(f"# W2 close protocol — {args.since} -> {args.until}  (tag {args.tag})")

    shadow = check_shadow_continuity(t0, t1)
    hours = check_collector_hours(t0, t1)
    say(f"\n[1] G4 eligibility")
    say(f"  shadow: coverage {shadow.get('coverage', 0) * 100:.2f}%  max gap "
        f"{shadow.get('max_gap_h', 0):.2f}h  -> {'PASS' if shadow['ok'] else 'FAIL'}")
    for a, b in shadow.get("gaps", []):
        say(f"    gap {a} -> {b}")
    say(f"  collector: worst-channel {hours.get('worst_coverage', 0) * 100:.2f}%  "
        f"max missing run {hours.get('worst_gap_h', 0)}h  -> {'PASS' if hours['ok'] else 'FAIL'}")
    g4_ok = shadow["ok"] and hours["ok"]

    if args.offline_listing:
        with open(args.offline_listing) as f:
            listing = json.load(f)
    else:
        try:
            listing = fetch_settled_listing(t0, t1)
        except Exception as e:  # noqa: BLE001 — a failed fetch must fail the window, loudly
            print(f"NO-GO (data)" if args.interim else f"  exchange fetch FAILED: {e}")
            return 2
    os.makedirs(ANALYSIS_W2, exist_ok=True)
    listing_path = os.path.join(
        ANALYSIS_W2, f"settled-listing-{args.since[:10]}-{args.until[:10]}.json")
    with open(listing_path, "w") as f:
        json.dump(listing, f, indent=1)
    rec = reconcile(listing, t0, t1)
    say(f"\n[2] settlement reconciliation (F1)")
    say(f"  exchange settled: {rec['exchange']}  captured locally: {rec['captured']}  "
        f"missing: {len(rec['missing'])}  extra-local: {len(rec['extra_local'])}")
    if rec["missing"]:
        say(f"    missing: {', '.join(rec['missing'][:10])}"
            + (f" … +{len(rec['missing']) - 10}" if len(rec['missing']) > 10 else ""))
    rec_rate = len(rec["missing"]) / max(1, rec["exchange"])
    rec_ok = rec_rate <= FIRE_COVERAGE_TRIPWIRE

    fz = check_freeze(args.tag)
    say(f"\n[3] G5 freeze integrity -> {'PASS' if fz['ok'] else 'FAIL'}")
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
    if args.interim:
        print(proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "CONTINUE")
        return 0
    print(proc.stdout, end="")
    m = re.search(r"gates: (.+)$", proc.stdout, re.MULTILINE)
    if m:
        failed = re.findall(r"(G\d)\(FAIL\)", m.group(1))
        if not failed:
            print("\nVERDICT: GO — full battery PASS on an eligible, frozen window")
        elif set(failed) & {"G7"}:
            print(f"\nVERDICT: NO-GO (mechanism) — failed: {', '.join(failed)}")
        elif set(failed) & {"G3"}:
            print(f"\nVERDICT: NO-GO (execution) — failed: {', '.join(failed)}")
        else:
            print(f"\nVERDICT: NO-GO (economics) — failed: {', '.join(failed)}"
                  "\n  (annex §3 erratum: at se ≈ 48¢/√n this is NOT evidence of no edge)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
