#!/usr/bin/env python3
"""Autoresearch scoring for Candidate 3 — fair-value cap + edge-floor replay.

For each of the 287 historical filled trades in kalshi-dust-state.json, decide
whether a NEW (FAIR_MIN, FAIR_MAX, EDGE_FLOOR, SAFETY_BUFFER) configuration
would have STILL accepted the trade. Sum realized PnL across accepted trades.

The replay can only filter DOWN (remove trades), never add new ones — only
trades actually accepted by SOME historical config appear in the candidate set.

This script does NOT modify worker code. It is a pure offline replay over a
frozen ledger snapshot.

Usage:
    python3 autoresearch_caps/score.py configs/baseline.json
    python3 autoresearch_caps/score.py --selftest

Output:
    Final line:  SCORE: 4.523        (= total replay PnL in $)
    Plus JSON blob to stdout and a copy at analysis/brier/autoresearch_caps_<name>.json.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
DUST_STATE = REPO_ROOT / "apps" / "market-worker" / "logs" / "kalshi-dust-state.json"
OUT_DIR = REPO_ROOT / "analysis" / "brier"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Pass thresholds
PNL_PASS_THRESHOLD = 0.0       # total replay PnL must be > $0
TRADE_RETENTION_FLOOR = 50     # absolute count; do not let configs degenerate to "skip almost everything"
ASSET_DOMINANCE_CAP = 0.60     # no single asset > 60% of PnL improvement over baseline
FOLD_DOMINANCE_CAP = 0.50      # no single time-fold > 50% of PnL improvement
N_FOLDS = 4                    # split trades into 4 equal time-ordered folds
SEED = 42
BOOTSTRAP_B = 1000

# Live-trading reference values (do not modify — these are the baseline
# parameters the originally-shipped fairValueArb strategy used)
BASELINE_FAIR_MIN = 0.0
BASELINE_FAIR_MAX = 1.0
BASELINE_EDGE_FLOOR = 0.0075
BASELINE_SAFETY_BUFFER = 0.005


# -------------------------------------------------------------------------
# Config
# -------------------------------------------------------------------------

@dataclass
class Config:
    name: str
    fair_min: float
    fair_max: float
    edge_floor: float
    safety_buffer: float

    @classmethod
    def from_dict(cls, d: dict) -> "Config":
        name = str(d.get("name", "unnamed"))
        fair_min = float(d.get("fair_min", 0.0))
        fair_max = float(d.get("fair_max", 1.0))
        edge_floor = float(d.get("edge_floor", 0.0075))
        safety_buffer = float(d.get("safety_buffer", 0.005))
        if not (0.0 <= fair_min < fair_max <= 1.0):
            raise ValueError(f"need 0 <= fair_min < fair_max <= 1, got [{fair_min}, {fair_max}]")
        if not (0.0 <= edge_floor <= 0.30):
            raise ValueError(f"edge_floor {edge_floor} outside [0, 0.30]")
        if not (0.0 <= safety_buffer <= 0.05):
            raise ValueError(f"safety_buffer {safety_buffer} outside [0, 0.05]")
        return cls(
            name=name,
            fair_min=fair_min,
            fair_max=fair_max,
            edge_floor=edge_floor,
            safety_buffer=safety_buffer,
        )


# -------------------------------------------------------------------------
# Data loading
# -------------------------------------------------------------------------

def load_filled_trades() -> list[dict]:
    state = json.loads(DUST_STATE.read_text())
    out = []
    for c in state.get("candidates", []):
        if c.get("status") != "filled":
            continue
        if c.get("realized_pnl_usd") is None:
            continue
        if c.get("fair_yes") is None:
            continue
        if c.get("ask_price") is None:
            continue
        side = c.get("side")
        if side not in ("YES", "NO"):
            continue
        out.append({
            "ticker": c.get("ticker"),
            "series": c.get("series", "?"),
            "close_time": c.get("close_time"),
            "fair_yes": float(c["fair_yes"]),
            "ask_price": float(c["ask_price"]),
            "side": side,
            "realized_pnl_usd": float(c["realized_pnl_usd"]),
            "edge_at_decision": float(c.get("edge", 0.0)),
        })
    return out


def assign_time_folds(trades: list[dict], n_folds: int = N_FOLDS) -> list[dict]:
    """Sort by close_time, split into n equal contiguous folds."""
    import pandas as pd
    df = pd.DataFrame(trades)
    df["ct"] = pd.to_datetime(df["close_time"], utc=True, errors="coerce")
    df = df.sort_values("ct").reset_index(drop=True)
    n = len(df)
    fold_labels = []
    for i in range(n):
        f = min(n_folds - 1, int(i * n_folds / n))
        fold_labels.append(f"f{f+1}")
    df["fold"] = fold_labels
    return df.to_dict("records")


# -------------------------------------------------------------------------
# Replay logic
# -------------------------------------------------------------------------

def apply_config(trades: list[dict], cfg: Config) -> dict:
    """Apply cap + edge-floor filter. Return retained trades with new-edge column."""
    threshold = cfg.safety_buffer + cfg.edge_floor
    retained = []
    for t in trades:
        fair_clamped = min(max(t["fair_yes"], cfg.fair_min), cfg.fair_max)
        if t["side"] == "YES":
            new_edge = fair_clamped - t["ask_price"]
        else:  # NO
            new_edge = (1.0 - fair_clamped) - t["ask_price"]
        if new_edge >= threshold:
            r = dict(t)
            r["fair_clamped"] = fair_clamped
            r["new_edge"] = new_edge
            retained.append(r)
    return {
        "retained": retained,
        "n_retained": len(retained),
        "n_dropped": len(trades) - len(retained),
        "total_pnl": sum(r["realized_pnl_usd"] for r in retained),
        "win_rate": (
            sum(1 for r in retained if r["realized_pnl_usd"] > 0) / len(retained)
            if retained else 0.0
        ),
        "n_yes": sum(1 for r in retained if r["side"] == "YES"),
        "n_no": sum(1 for r in retained if r["side"] == "NO"),
    }


def per_asset_breakdown(retained: list[dict], baseline_pnl_by_series: dict[str, float]) -> list[dict]:
    """For each series, total kept PnL + delta vs the per-series baseline PnL."""
    by_series: dict[str, list[dict]] = {}
    for r in retained:
        by_series.setdefault(r["series"], []).append(r)
    out = []
    for s, rs in sorted(by_series.items()):
        pnl_kept = sum(r["realized_pnl_usd"] for r in rs)
        pnl_base = baseline_pnl_by_series.get(s, 0.0)
        out.append({
            "series": s,
            "n": len(rs),
            "pnl_kept": pnl_kept,
            "pnl_baseline_all_trades": pnl_base,
            "pnl_delta_vs_baseline": pnl_kept - pnl_base,
            "win_rate": sum(1 for r in rs if r["realized_pnl_usd"] > 0) / len(rs) if rs else 0.0,
        })
    return out


def per_fold_breakdown(retained: list[dict], baseline_pnl_by_fold: dict[str, float]) -> list[dict]:
    by_fold: dict[str, list[dict]] = {}
    for r in retained:
        by_fold.setdefault(r["fold"], []).append(r)
    out = []
    for f in sorted(by_fold):
        rs = by_fold[f]
        pnl_kept = sum(r["realized_pnl_usd"] for r in rs)
        pnl_base = baseline_pnl_by_fold.get(f, 0.0)
        out.append({
            "fold": f,
            "n": len(rs),
            "pnl_kept": pnl_kept,
            "pnl_baseline_all_trades": pnl_base,
            "pnl_delta_vs_baseline": pnl_kept - pnl_base,
        })
    return out


def bootstrap_pnl_ci(retained: list[dict], B: int = BOOTSTRAP_B, seed: int = SEED) -> tuple[float, float]:
    """Bootstrap CI on total PnL of retained trades. Resample trades with replacement.
    Returns (ci_low_2.5%, ci_high_97.5%).
    """
    pnls = np.array([r["realized_pnl_usd"] for r in retained])
    n = len(pnls)
    if n == 0:
        return (0.0, 0.0)
    rng = np.random.default_rng(seed)
    boot = np.empty(B, dtype=float)
    for i in range(B):
        idx = rng.integers(0, n, size=n)
        boot[i] = float(pnls[idx].sum())
    return (float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5)))


# -------------------------------------------------------------------------
# Score
# -------------------------------------------------------------------------

def score_config(cfg: Config) -> dict:
    raw_trades = load_filled_trades()
    if not raw_trades:
        return {"status": "no_trades", "cfg": asdict(cfg)}
    trades = assign_time_folds(raw_trades)

    baseline_cfg = Config(
        name="baseline_live",
        fair_min=BASELINE_FAIR_MIN,
        fair_max=BASELINE_FAIR_MAX,
        edge_floor=BASELINE_EDGE_FLOOR,
        safety_buffer=BASELINE_SAFETY_BUFFER,
    )
    baseline = apply_config(trades, baseline_cfg)
    candidate = apply_config(trades, cfg)

    # Per-asset / per-fold totals on the FULL trade set (for delta accounting)
    baseline_pnl_by_series: dict[str, float] = {}
    baseline_pnl_by_fold: dict[str, float] = {}
    for t in trades:
        baseline_pnl_by_series[t["series"]] = baseline_pnl_by_series.get(t["series"], 0.0) + t["realized_pnl_usd"]
        baseline_pnl_by_fold[t["fold"]] = baseline_pnl_by_fold.get(t["fold"], 0.0) + t["realized_pnl_usd"]

    per_asset = per_asset_breakdown(candidate["retained"], baseline_pnl_by_series)
    per_fold = per_fold_breakdown(candidate["retained"], baseline_pnl_by_fold)

    # Delta improvement vs baseline (which is essentially the full set; but baseline
    # applied to itself drops the few trades whose edge < 0.0125 — should be 0 in
    # practice because every filled trade had edge >= 0.0125 by construction)
    delta_pnl = candidate["total_pnl"] - baseline["total_pnl"]
    total_improvement = delta_pnl  # absolute $ units; >0 means candidate is better

    ci_low, ci_high = bootstrap_pnl_ci(candidate["retained"])

    # Dominance checks: which asset / fold contributes most of the improvement?
    largest_asset_share = 0.0
    largest_asset = None
    if abs(total_improvement) > 1e-6:
        for row in per_asset:
            share = row["pnl_delta_vs_baseline"] / total_improvement if total_improvement > 0 else 0.0
            if share > largest_asset_share:
                largest_asset_share = share
                largest_asset = row["series"]

    largest_fold_share = 0.0
    largest_fold = None
    if abs(total_improvement) > 1e-6:
        for row in per_fold:
            share = row["pnl_delta_vs_baseline"] / total_improvement if total_improvement > 0 else 0.0
            if share > largest_fold_share:
                largest_fold_share = share
                largest_fold = row["fold"]

    pass_flags = {
        "pnl_positive": candidate["total_pnl"] > PNL_PASS_THRESHOLD,
        "ci_excludes_zero": ci_low > 0,
        "retention_ok": candidate["n_retained"] >= TRADE_RETENTION_FLOOR,
        "no_single_asset_dominance": (
            largest_asset_share <= ASSET_DOMINANCE_CAP if total_improvement > 0 else False
        ),
        "no_single_fold_dominance": (
            largest_fold_share <= FOLD_DOMINANCE_CAP if total_improvement > 0 else False
        ),
        "improves_over_baseline": delta_pnl > 0,
    }
    passes = all(pass_flags.values())

    return {
        "status": "scored",
        "cfg": asdict(cfg),
        "passes_all_gates": passes,
        "pass_flags": pass_flags,
        "baseline_pnl": baseline["total_pnl"],
        "baseline_n_retained": baseline["n_retained"],
        "candidate_pnl": candidate["total_pnl"],
        "candidate_n_retained": candidate["n_retained"],
        "candidate_win_rate": candidate["win_rate"],
        "candidate_n_yes": candidate["n_yes"],
        "candidate_n_no": candidate["n_no"],
        "delta_pnl": delta_pnl,
        "ci_low": ci_low,
        "ci_high": ci_high,
        "per_asset": per_asset,
        "per_fold": per_fold,
        "largest_asset": largest_asset,
        "largest_asset_share": largest_asset_share,
        "largest_fold": largest_fold,
        "largest_fold_share": largest_fold_share,
        "constants": {
            "pnl_pass_threshold": PNL_PASS_THRESHOLD,
            "trade_retention_floor": TRADE_RETENTION_FLOOR,
            "asset_dominance_cap": ASSET_DOMINANCE_CAP,
            "fold_dominance_cap": FOLD_DOMINANCE_CAP,
            "n_folds": N_FOLDS,
            "seed": SEED,
            "bootstrap_B": BOOTSTRAP_B,
            "baseline_fair_min": BASELINE_FAIR_MIN,
            "baseline_fair_max": BASELINE_FAIR_MAX,
            "baseline_edge_floor": BASELINE_EDGE_FLOOR,
            "baseline_safety_buffer": BASELINE_SAFETY_BUFFER,
        },
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: score.py <config.json | -> | --selftest", file=sys.stderr)
        return 2

    if argv[1] == "--selftest":
        cfg = Config.from_dict({
            "name": "selftest_baseline",
            "fair_min": BASELINE_FAIR_MIN,
            "fair_max": BASELINE_FAIR_MAX,
            "edge_floor": BASELINE_EDGE_FLOOR,
            "safety_buffer": BASELINE_SAFETY_BUFFER,
        })
        results = []
        for _ in range(3):
            r = score_config(cfg)
            results.append({
                "candidate_pnl": r["candidate_pnl"],
                "n_retained": r["candidate_n_retained"],
                "ci_low": r["ci_low"],
            })
        print(json.dumps({"selftest_runs": results}, indent=2))
        return 0

    if argv[1] == "-":
        cfg_dict = json.load(sys.stdin)
    else:
        cfg_dict = json.loads(Path(argv[1]).read_text())
    cfg = Config.from_dict(cfg_dict)
    result = score_config(cfg)

    out_path = OUT_DIR / f"autoresearch_caps_{cfg.name}.json"
    out_path.write_text(json.dumps(result, indent=2, default=str))

    print(json.dumps(result, indent=2, default=str))
    score = result.get("candidate_pnl", float("nan"))
    print(f"SCORE: {score:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
