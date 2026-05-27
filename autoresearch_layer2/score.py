#!/usr/bin/env python3
"""Autoresearch scoring wrapper for Layer-2 feature bakeoff on Kalshi 15-min binaries.

Primary metric: ΔBrier-skill (Layer-2 model minus Gaussian-only baseline) on the
EXECUTABLE-PROXY universe (subset of shadow_with_basis with p_gaussian in
[0.20, 0.80] and the >=90s decision-time gate). This approximates the markets
the live executor would actually consider, avoiding the trivially-decided
95/5 markets that dominate the raw shadow universe.

The pass condition requires:
  1. ΔBrier-skill on primary executable proxy >= 5 percentage points
  2. Bootstrap 95% CI on the delta excludes zero (paired bootstrap)
  3. Retention >= 80% within the executable proxy (rows with all features)
  4. No single asset accounts for >60% of the improvement
  5. No single fold accounts for >50% of the improvement
  6. Simulated net edge on executable subset positive after fees

A secondary executable proxy (p_gaussian in [0.10, 0.90]) is reported as a
sensitivity check. The full shadow_with_basis universe is reported as a
diagnostic only — NEVER used to make the pass/fail decision.

This script DOES NOT modify brier_bakeoff.py. It imports the data-loading
functions from it and reuses them. The scoring logic is in isolation here.

Usage:
    python3 autoresearch_layer2/score.py configs/baseline.json
    python3 autoresearch_layer2/score.py - < configs/baseline.json   # stdin
    python3 autoresearch_layer2/score.py --selftest                  # noise check

Output:
    Final line:  SCORE: 0.0234        (= ΔBrier-skill on primary executable proxy)
    Plus JSON blob to stdout (machine-readable) and a copy at
    analysis/brier/autoresearch_score_<name>.json.

Determinism: fixed seeds for any bootstrap; no randomness in fits.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import ndtri
from scipy.stats import t as student_t_dist
from sklearn.linear_model import LogisticRegression

REPO_ROOT = Path(__file__).resolve().parents[1]
BAKEOFF_DIR = REPO_ROOT / "apps" / "market-worker" / "scripts"
OUT_DIR = REPO_ROOT / "analysis" / "brier"
OUT_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(BAKEOFF_DIR))
import brier_bakeoff as bb  # noqa: E402

EPS = 1e-4
CLIMATOLOGY_BRIER = 0.250
SECS_TO_CLOSE_GATE = 90.0

# Universe band definitions
EXECUTABLE_PROXY_PRIMARY = (0.20, 0.80)
EXECUTABLE_PROXY_SECONDARY = (0.10, 0.90)

# Pass thresholds
DELTA_SKILL_PASS_THRESHOLD = 0.05  # 5 percentage points
TRADE_RETENTION_FLOOR = 0.80
ASSET_DOMINANCE_CAP = 0.60
FOLD_DOMINANCE_CAP = 0.50

# Simulated PnL parameters
PNL_EDGE_FLOOR = 0.05   # only "trade" if |edge| >= 5 cents (matches KALSHI_DEF_YES_MIN_EDGE spirit)
KALSHI_FEE_RATE = 0.07  # 7% of profit on winning contracts

SEED = 42
BOOTSTRAP_B = 1000

ALLOWED_FEATURES = ("basis_bps", "funding_rate", "basis_change_bps")
ALLOWED_TRANSFORMS = ("raw", "zscore", "winsor")
CUTPOINTS = [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 1.00)]


# -------------------------------------------------------------------------
# Config
# -------------------------------------------------------------------------

@dataclass
class Config:
    name: str
    features: list[str]
    transforms: dict[str, str]
    interactions: list[list[str]]
    C: float
    include_student_t: bool
    student_t_grid: dict[str, list[float]] | None

    @classmethod
    def from_dict(cls, d: dict) -> "Config":
        feats = list(d.get("features", []))
        for f in feats:
            if f not in ALLOWED_FEATURES:
                raise ValueError(f"feature {f!r} not in {ALLOWED_FEATURES}")
        if len(feats) != len(set(feats)):
            raise ValueError(f"duplicate feature in {feats}")
        transforms = dict(d.get("transforms", {}))
        for f, t in transforms.items():
            if f not in ALLOWED_FEATURES:
                raise ValueError(f"transform key {f!r} not in {ALLOWED_FEATURES}")
            if t not in ALLOWED_TRANSFORMS:
                raise ValueError(f"transform {t!r} not in {ALLOWED_TRANSFORMS}")
        interactions = [list(p) for p in d.get("interactions", [])]
        for pair in interactions:
            if len(pair) != 2 or pair[0] == pair[1]:
                raise ValueError(f"interaction must be 2 distinct features: {pair}")
            for f in pair:
                if f not in feats:
                    raise ValueError(f"interaction {pair} uses feature {f!r} not in features")
        C = float(d.get("C", 1.0))
        if C <= 0 or C > 1e6:
            raise ValueError(f"C={C} outside (0, 1e6]")
        include_t = bool(d.get("include_student_t", False))
        t_grid = d.get("student_t_grid")
        return cls(
            name=str(d.get("name", "unnamed")),
            features=feats,
            transforms=transforms,
            interactions=interactions,
            C=C,
            include_student_t=include_t,
            student_t_grid=t_grid,
        )


# -------------------------------------------------------------------------
# Data loading (read-only, via brier_bakeoff)
# -------------------------------------------------------------------------

def load_shadow_universe() -> pd.DataFrame:
    """Decision-time row (>=90s to close) per ticker, joined with settlement label.
    Adds derived `basis_change_bps` column (per-asset diff of basis_bps).
    """
    val = bb.load_validator_rows()
    layer2 = bb.load_bakeoff_shadow(decision_secs=SECS_TO_CLOSE_GATE)
    shadow = bb.merge_layer2_with_settlements(layer2, val)
    if len(shadow) and "basis_bps" in shadow.columns:
        shadow = shadow.sort_values(["asset", "close_time"]).reset_index(drop=True)
        shadow["basis_change_bps"] = (
            shadow.groupby("asset")["basis_bps"].diff().fillna(0.0)
        )
    return shadow


def universe_filter(
    df: pd.DataFrame,
    p_band: tuple[float, float],
    features_needed: list[str],
) -> tuple[pd.DataFrame, float]:
    """Apply (band, secs_to_close, features non-null) filter.
    Returns (filtered_df, retention) where retention = filtered_with_features / filtered_band_only.
    """
    if len(df) == 0:
        return df, 0.0
    lo, hi = p_band
    band_mask = (
        (df["p_gaussian"] >= lo)
        & (df["p_gaussian"] <= hi)
        & (df["secs_to_close"] >= SECS_TO_CLOSE_GATE)
    )
    band_df = df[band_mask].copy()
    if features_needed:
        feat_mask = band_df[features_needed].notna().all(axis=1)
        filtered = band_df[feat_mask].copy()
    else:
        filtered = band_df.copy()
    retention = float(len(filtered) / len(band_df)) if len(band_df) else 0.0
    return filtered, retention


# -------------------------------------------------------------------------
# Feature transforms (TRAIN-fitted, TEST-applied — no leakage)
# -------------------------------------------------------------------------

@dataclass
class TransformParams:
    kind: str
    a: float  # zscore mean | winsor lo
    b: float  # zscore std  | winsor hi


def fit_transform(values: np.ndarray, kind: str) -> TransformParams:
    arr = values[~np.isnan(values)]
    if len(arr) == 0:
        return TransformParams(kind=kind, a=0.0, b=1.0)
    if kind == "raw":
        return TransformParams(kind="raw", a=0.0, b=1.0)
    if kind == "zscore":
        return TransformParams(kind="zscore", a=float(arr.mean()), b=float(arr.std() or 1.0))
    if kind == "winsor":
        lo = float(np.percentile(arr, 1))
        hi = float(np.percentile(arr, 99))
        return TransformParams(kind="winsor", a=lo, b=hi)
    raise ValueError(f"unknown transform kind {kind!r}")


def apply_transform(values: np.ndarray, params: TransformParams) -> np.ndarray:
    if params.kind == "raw":
        return values
    if params.kind == "zscore":
        std = params.b if params.b != 0 else 1.0
        return (values - params.a) / std
    if params.kind == "winsor":
        return np.clip(values, params.a, params.b)
    raise ValueError(f"unknown transform kind {params.kind!r}")


# -------------------------------------------------------------------------
# Model fit / predict
# -------------------------------------------------------------------------

def build_feature_matrix(
    df: pd.DataFrame,
    cfg: Config,
    transform_params: dict[str, TransformParams],
) -> tuple[np.ndarray, list[str]]:
    p = np.clip(df["p_gaussian"].to_numpy(dtype=float), EPS, 1 - EPS)
    cols: list[np.ndarray] = [np.log(p / (1 - p))]
    names: list[str] = ["logit_p_gaussian"]
    transformed: dict[str, np.ndarray] = {}
    for feat in cfg.features:
        raw = df[feat].fillna(0.0).to_numpy(dtype=float)
        params = transform_params[feat]
        transformed[feat] = apply_transform(raw, params)
        cols.append(transformed[feat])
        names.append(f"{feat}__{params.kind}")
    for pair in cfg.interactions:
        a, b = pair
        prod = transformed[a] * transformed[b]
        cols.append(prod)
        names.append(f"interact__{a}__x__{b}")
    return np.column_stack(cols), names


def fit_and_predict(
    train: pd.DataFrame,
    test: pd.DataFrame,
    cfg: Config,
) -> tuple[np.ndarray, dict] | None:
    """Fit transforms on TRAIN only, fit LR on TRAIN, predict on TEST."""
    needed = ["p_gaussian", "y_yes", *cfg.features]
    train_clean = train.dropna(subset=needed)
    if len(train_clean) < 30:
        return None
    transform_params: dict[str, TransformParams] = {}
    for feat in cfg.features:
        kind = cfg.transforms.get(feat, "raw")
        transform_params[feat] = fit_transform(train_clean[feat].to_numpy(dtype=float), kind)
    X_train, names = build_feature_matrix(train_clean, cfg, transform_params)
    y_train = train_clean["y_yes"].to_numpy()
    if len(np.unique(y_train)) < 2:
        return None
    lr = LogisticRegression(C=cfg.C, max_iter=2000)
    lr.fit(X_train, y_train)
    X_test, _ = build_feature_matrix(test, cfg, transform_params)
    p_pred = lr.predict_proba(X_test)[:, 1]
    meta = {
        "intercept": float(lr.intercept_[0]),
        "coefs": {n: float(c) for n, c in zip(names, lr.coef_[0])},
        "transform_params": {f: asdict(transform_params[f]) for f in transform_params},
        "n_train": len(train_clean),
    }
    return p_pred, meta


# -------------------------------------------------------------------------
# Walk-forward scoring (paired baseline + model)
# -------------------------------------------------------------------------

@dataclass
class FoldPredictions:
    fold: str
    n_train: int
    n_test: int
    baseline_p: np.ndarray
    model_p: np.ndarray
    y: np.ndarray
    asset: np.ndarray
    fit_meta: dict | None


def walk_forward_paired(df_filtered: pd.DataFrame, cfg: Config) -> list[FoldPredictions]:
    """For each fold, fit model on train and produce baseline + model predictions
    on TEST. df_filtered is already the executable-proxy universe with all
    required features non-null (so retention is 100% within this DF; the gate
    on retention is checked upstream against the band-only count).
    """
    d = df_filtered.sort_values("close_time").reset_index(drop=True)
    n = len(d)
    if n < 80:
        return []
    out: list[FoldPredictions] = []
    for train_end_frac, test_end_frac in CUTPOINTS:
        train_end = int(n * train_end_frac)
        test_end = int(n * test_end_frac)
        train = d.iloc[:train_end]
        test = d.iloc[train_end:test_end]
        if len(train) < 50 or len(test) < 10:
            continue
        baseline_p = np.clip(test["p_gaussian"].to_numpy(dtype=float), EPS, 1 - EPS)
        if not cfg.features:
            model_p = baseline_p.copy()
            fit_meta = {"note": "baseline_passthrough"}
        else:
            result = fit_and_predict(train, test, cfg)
            if result is None:
                continue
            model_p, fit_meta = result
        out.append(FoldPredictions(
            fold=f"{train_end_frac:.0%}->{test_end_frac:.0%}",
            n_train=len(train),
            n_test=len(test),
            baseline_p=baseline_p,
            model_p=model_p,
            y=test["y_yes"].to_numpy(),
            asset=test["asset"].to_numpy(),
            fit_meta=fit_meta,
        ))
    return out


# -------------------------------------------------------------------------
# Aggregation + bootstrap ΔBrier
# -------------------------------------------------------------------------

def skill_from_brier(brier_val: float) -> float:
    return 1 - brier_val / CLIMATOLOGY_BRIER


def aggregate_paired(folds: list[FoldPredictions]) -> dict:
    if not folds:
        return {"status": "no_valid_folds"}
    base_all = np.concatenate([f.baseline_p for f in folds])
    model_all = np.concatenate([f.model_p for f in folds])
    y_all = np.concatenate([f.y for f in folds])
    asset_all = np.concatenate([f.asset for f in folds])
    fold_idx = np.concatenate([np.full(len(f.y), i, dtype=int) for i, f in enumerate(folds)])

    base_brier = float(((base_all - y_all) ** 2).mean())
    model_brier = float(((model_all - y_all) ** 2).mean())
    base_skill = skill_from_brier(base_brier)
    model_skill = skill_from_brier(model_brier)
    delta_skill = model_skill - base_skill

    # Paired bootstrap on delta-skill
    rng = np.random.default_rng(SEED)
    n = len(y_all)
    deltas = np.empty(BOOTSTRAP_B, dtype=float)
    for i in range(BOOTSTRAP_B):
        idx = rng.integers(0, n, size=n)
        b = float(((base_all[idx] - y_all[idx]) ** 2).mean())
        m = float(((model_all[idx] - y_all[idx]) ** 2).mean())
        deltas[i] = skill_from_brier(m) - skill_from_brier(b)
    ci_low = float(np.percentile(deltas, 2.5))
    ci_high = float(np.percentile(deltas, 97.5))

    # Per-asset breakdown of model improvement
    per_asset = []
    asset_share = {}
    for a in np.unique(asset_all):
        mask = asset_all == a
        if mask.sum() < 3:
            continue
        a_base_brier = float(((base_all[mask] - y_all[mask]) ** 2).mean())
        a_model_brier = float(((model_all[mask] - y_all[mask]) ** 2).mean())
        a_delta_brier = a_base_brier - a_model_brier  # positive = improvement
        # Contribution to total delta-skill (weighted by sample share)
        weight = mask.sum() / n
        contrib = weight * a_delta_brier / CLIMATOLOGY_BRIER  # in skill units
        per_asset.append({
            "asset": str(a),
            "n": int(mask.sum()),
            "baseline_brier": a_base_brier,
            "model_brier": a_model_brier,
            "delta_brier": a_delta_brier,
            "skill_contribution_pp": contrib,
        })
        asset_share[str(a)] = contrib
    per_asset.sort(key=lambda r: r["asset"])

    total_delta = delta_skill
    largest_asset_share = 0.0
    largest_asset = None
    if total_delta > 0 and asset_share:
        for a, c in asset_share.items():
            share = c / total_delta if total_delta > 0 else 0.0
            if share > largest_asset_share:
                largest_asset_share = share
                largest_asset = a
    elif total_delta <= 0:
        largest_asset_share = float("nan")

    # Per-fold breakdown
    per_fold = []
    fold_share = {}
    for i, f in enumerate(folds):
        mask = fold_idx == i
        if not mask.any():
            continue
        f_base_brier = float(((base_all[mask] - y_all[mask]) ** 2).mean())
        f_model_brier = float(((model_all[mask] - y_all[mask]) ** 2).mean())
        f_delta_brier = f_base_brier - f_model_brier
        weight = mask.sum() / n
        contrib = weight * f_delta_brier / CLIMATOLOGY_BRIER
        per_fold.append({
            "fold": f.fold,
            "n_test": int(mask.sum()),
            "baseline_brier": f_base_brier,
            "model_brier": f_model_brier,
            "delta_brier": f_delta_brier,
            "skill_contribution_pp": contrib,
        })
        fold_share[f.fold] = contrib

    largest_fold_share = 0.0
    largest_fold = None
    if total_delta > 0 and fold_share:
        for f, c in fold_share.items():
            share = c / total_delta if total_delta > 0 else 0.0
            if share > largest_fold_share:
                largest_fold_share = share
                largest_fold = f
    elif total_delta <= 0:
        largest_fold_share = float("nan")

    return {
        "status": "ok",
        "n_pooled": n,
        "baseline_brier": base_brier,
        "model_brier": model_brier,
        "baseline_skill": base_skill,
        "model_skill": model_skill,
        "delta_skill": delta_skill,
        "delta_skill_ci_low": ci_low,
        "delta_skill_ci_high": ci_high,
        "per_fold": per_fold,
        "per_asset": per_asset,
        "largest_asset": largest_asset,
        "largest_asset_share": largest_asset_share,
        "largest_fold": largest_fold,
        "largest_fold_share": largest_fold_share,
    }


# -------------------------------------------------------------------------
# Simulated net edge / PnL with fees
# -------------------------------------------------------------------------

def simulate_net_edge(folds: list[FoldPredictions], df_filtered: pd.DataFrame) -> dict:
    """For each test row, the model picks YES/NO/SKIP based on edge floor.
    Realized PnL uses real ask prices from the shadow data when available.
    Kalshi fee (7% of profit) applied to winning trades.

    Trade rule (model side):
        edge_yes = model_p - ask_yes;  trade YES if edge_yes >= PNL_EDGE_FLOOR
        edge_no  = (1 - model_p) - ask_no;  trade NO  if edge_no >= PNL_EDGE_FLOOR
        else SKIP
    Per-contract realized: win -> (1 - ask) * (1 - fee_rate); loss -> -ask.
    Same rule applied to BASELINE predictions for an apples-to-apples comparison.
    """
    if not folds:
        return {"status": "no_folds"}
    base_all = np.concatenate([f.baseline_p for f in folds])
    model_all = np.concatenate([f.model_p for f in folds])
    y_all = np.concatenate([f.y for f in folds])

    # Recover ask prices via merge on row order — folds were built from
    # df_filtered.sort_values("close_time"), and we walked it slice by slice.
    d = df_filtered.sort_values("close_time").reset_index(drop=True)
    n_full = len(d)
    # Reconstruct the index range for each fold to pull ask columns in order
    test_idx = []
    for f, frac in zip(folds, CUTPOINTS):
        train_end_frac, test_end_frac = frac
        train_end = int(n_full * train_end_frac)
        test_end = int(n_full * test_end_frac)
        if test_end - train_end != len(f.y):
            # CUTPOINTS may have skipped a fold; fall back to walking until we
            # find the slice matching length
            continue
        test_idx.append(np.arange(train_end, test_end))
    if not test_idx:
        return {"status": "fold_index_mismatch"}
    idx_all = np.concatenate(test_idx)
    if len(idx_all) != len(y_all):
        return {"status": "index_length_mismatch", "idx": len(idx_all), "y": len(y_all)}

    ask_yes = d["best_yes_ask"].iloc[idx_all].to_numpy(dtype=float)
    ask_no = d["best_no_ask"].iloc[idx_all].to_numpy(dtype=float)

    def replay(model_probs: np.ndarray) -> dict:
        edge_yes = model_probs - ask_yes
        edge_no = (1 - model_probs) - ask_no
        take_yes = (edge_yes >= PNL_EDGE_FLOOR) & np.isfinite(ask_yes)
        take_no = (edge_no >= PNL_EDGE_FLOOR) & np.isfinite(ask_no) & (~take_yes)
        skip = ~(take_yes | take_no)
        pnl = np.zeros(len(model_probs), dtype=float)
        # YES trades
        yes_win = take_yes & (y_all == 1)
        yes_lose = take_yes & (y_all == 0)
        pnl[yes_win] = (1.0 - ask_yes[yes_win]) * (1.0 - KALSHI_FEE_RATE)
        pnl[yes_lose] = -ask_yes[yes_lose]
        # NO trades
        no_win = take_no & (y_all == 0)
        no_lose = take_no & (y_all == 1)
        pnl[no_win] = (1.0 - ask_no[no_win]) * (1.0 - KALSHI_FEE_RATE)
        pnl[no_lose] = -ask_no[no_lose]
        n_trades = int((~skip).sum())
        return {
            "n_decisions": int(len(model_probs)),
            "n_trades": n_trades,
            "n_skips": int(skip.sum()),
            "n_yes": int(take_yes.sum()),
            "n_no": int(take_no.sum()),
            "win_rate": float((pnl > 0).sum() / n_trades) if n_trades else 0.0,
            "total_pnl": float(pnl.sum()),
            "avg_pnl_per_trade": float(pnl.sum() / n_trades) if n_trades else 0.0,
            "avg_pnl_per_decision": float(pnl.sum() / len(model_probs)),
        }

    base_replay = replay(base_all)
    model_replay = replay(model_all)
    return {
        "status": "ok",
        "params": {
            "edge_floor": PNL_EDGE_FLOOR,
            "fee_rate": KALSHI_FEE_RATE,
        },
        "baseline": base_replay,
        "model": model_replay,
        "delta_total_pnl": model_replay["total_pnl"] - base_replay["total_pnl"],
    }


# -------------------------------------------------------------------------
# Universe-level scoring
# -------------------------------------------------------------------------

def score_universe(
    shadow: pd.DataFrame,
    cfg: Config,
    label: str,
    p_band: tuple[float, float],
) -> dict:
    filtered, retention = universe_filter(shadow, p_band, cfg.features)
    if len(filtered) < 80:
        return {
            "status": "insufficient_filtered_data",
            "label": label,
            "p_band": list(p_band),
            "n_filtered": len(filtered),
            "retention": retention,
        }
    folds = walk_forward_paired(filtered, cfg)
    if not folds:
        return {
            "status": "no_valid_folds",
            "label": label,
            "p_band": list(p_band),
            "n_filtered": len(filtered),
            "retention": retention,
        }
    agg = aggregate_paired(folds)
    pnl = simulate_net_edge(folds, filtered)
    agg["label"] = label
    agg["p_band"] = list(p_band)
    agg["retention"] = retention
    agg["net_edge"] = pnl
    return agg


# -------------------------------------------------------------------------
# Student-t (optional add-on, runs on primary executable proxy)
# -------------------------------------------------------------------------

def student_t_walk_forward(df_filtered: pd.DataFrame, grid: dict[str, list[float]]) -> dict:
    d = df_filtered.sort_values("close_time").reset_index(drop=True)
    n = len(d)
    if n < 80:
        return {"status": "insufficient_data", "n": n}
    test_preds: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    folds = []
    for train_end_frac, test_end_frac in CUTPOINTS:
        train_end = int(n * train_end_frac)
        test_end = int(n * test_end_frac)
        train = d.iloc[:train_end]
        test = d.iloc[train_end:test_end]
        if len(train) < 50 or len(test) < 10:
            continue
        best = None
        p_train = np.clip(train["p_gaussian"].to_numpy(), EPS, 1 - EPS)
        z_train = ndtri(p_train)
        y_train = train["y_yes"].to_numpy()
        for nu in grid["nu"]:
            for beta in grid["beta"]:
                for alpha in grid["alpha"]:
                    p_pred_train = student_t_dist.cdf(alpha + beta * z_train, df=nu)
                    b = float(((p_pred_train - y_train) ** 2).mean())
                    if best is None or b < best["train_brier"]:
                        best = {"nu": nu, "beta": beta, "alpha": alpha, "train_brier": b}
        p_test = np.clip(test["p_gaussian"].to_numpy(), EPS, 1 - EPS)
        z_test = ndtri(p_test)
        p_pred_test = student_t_dist.cdf(best["alpha"] + best["beta"] * z_test, df=best["nu"])
        baseline_p = p_test
        y_test = test["y_yes"].to_numpy()
        test_preds.append((p_pred_test, baseline_p, y_test))
        folds.append({
            "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
            "best_params": best,
            "test_brier": float(((p_pred_test - y_test) ** 2).mean()),
            "baseline_brier": float(((baseline_p - y_test) ** 2).mean()),
            "n_test": len(test),
        })
    if not test_preds:
        return {"status": "no_valid_folds"}
    all_model = np.concatenate([t[0] for t in test_preds])
    all_base = np.concatenate([t[1] for t in test_preds])
    all_y = np.concatenate([t[2] for t in test_preds])
    model_brier = float(((all_model - all_y) ** 2).mean())
    base_brier = float(((all_base - all_y) ** 2).mean())
    return {
        "status": "ok",
        "baseline_brier": base_brier,
        "model_brier": model_brier,
        "baseline_skill": skill_from_brier(base_brier),
        "model_skill": skill_from_brier(model_brier),
        "delta_skill": skill_from_brier(model_brier) - skill_from_brier(base_brier),
        "folds": folds,
    }


# -------------------------------------------------------------------------
# Top-level scoring + pass decision
# -------------------------------------------------------------------------

def score_config(cfg: Config) -> dict:
    shadow = load_shadow_universe()
    if len(shadow) == 0:
        return {"status": "no_shadow_data", "cfg": asdict(cfg)}

    primary = score_universe(shadow, cfg, "executable_proxy_primary", EXECUTABLE_PROXY_PRIMARY)
    secondary = score_universe(shadow, cfg, "executable_proxy_secondary", EXECUTABLE_PROXY_SECONDARY)
    # Diagnostic — full shadow with no band filter (still requires features)
    diag_filtered, diag_retention = universe_filter(
        shadow,
        (-float("inf"), float("inf")),
        cfg.features,
    )
    if len(diag_filtered) >= 80:
        diag_folds = walk_forward_paired(diag_filtered, cfg)
        diagnostic = aggregate_paired(diag_folds) if diag_folds else {"status": "no_folds"}
        diagnostic["label"] = "diagnostic_full_shadow"
        diagnostic["retention"] = diag_retention
    else:
        diagnostic = {"status": "insufficient_data", "n": len(diag_filtered)}

    student_t_block = None
    if cfg.include_student_t and cfg.student_t_grid:
        primary_filtered, _ = universe_filter(shadow, EXECUTABLE_PROXY_PRIMARY, [])
        student_t_block = student_t_walk_forward(primary_filtered, cfg.student_t_grid)

    primary_ok = primary.get("status") == "ok"
    pass_flags = {
        "delta_skill_ge_5pp": (
            primary_ok and primary.get("delta_skill", -1) >= DELTA_SKILL_PASS_THRESHOLD
        ),
        "ci_excludes_zero": (
            primary_ok and primary.get("delta_skill_ci_low", -1) > 0
        ),
        "retention_ok": (
            primary_ok and primary.get("retention", 0) >= TRADE_RETENTION_FLOOR
        ),
        "no_single_asset_dominance": (
            primary_ok
            and not (primary.get("largest_asset_share") != primary.get("largest_asset_share"))  # not NaN
            and primary.get("largest_asset_share", 1.0) <= ASSET_DOMINANCE_CAP
        ),
        "no_single_fold_dominance": (
            primary_ok
            and not (primary.get("largest_fold_share") != primary.get("largest_fold_share"))
            and primary.get("largest_fold_share", 1.0) <= FOLD_DOMINANCE_CAP
        ),
        "positive_net_edge": (
            primary_ok
            and primary.get("net_edge", {}).get("status") == "ok"
            and primary.get("net_edge", {}).get("model", {}).get("total_pnl", -1) > 0
        ),
    }
    passes = all(pass_flags.values())

    return {
        "status": "scored",
        "cfg": asdict(cfg),
        "passes_all_gates": passes,
        "pass_flags": pass_flags,
        "primary_executable_proxy": primary,
        "secondary_executable_proxy": secondary,
        "diagnostic_full_shadow": diagnostic,
        "student_t_block": student_t_block,
        "constants": {
            "climatology_brier": CLIMATOLOGY_BRIER,
            "delta_skill_pass_threshold": DELTA_SKILL_PASS_THRESHOLD,
            "trade_retention_floor": TRADE_RETENTION_FLOOR,
            "asset_dominance_cap": ASSET_DOMINANCE_CAP,
            "fold_dominance_cap": FOLD_DOMINANCE_CAP,
            "pnl_edge_floor": PNL_EDGE_FLOOR,
            "kalshi_fee_rate": KALSHI_FEE_RATE,
            "seed": SEED,
            "bootstrap_B": BOOTSTRAP_B,
            "primary_band": list(EXECUTABLE_PROXY_PRIMARY),
            "secondary_band": list(EXECUTABLE_PROXY_SECONDARY),
            "secs_to_close_gate": SECS_TO_CLOSE_GATE,
        },
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: score.py <config.json | -> | --selftest", file=sys.stderr)
        return 2

    if argv[1] == "--selftest":
        cfg = Config.from_dict({
            "name": "selftest_baseline",
            "features": [], "transforms": {}, "interactions": [],
            "C": 1.0, "include_student_t": False, "student_t_grid": None,
        })
        scores = []
        for _ in range(3):
            r = score_config(cfg)
            s = r.get("primary_executable_proxy", {}).get("delta_skill", float("nan"))
            scores.append(s)
        print(json.dumps({"selftest_delta_skills": scores, "variance": float(np.var(scores))}, indent=2))
        return 0

    if argv[1] == "-":
        cfg_dict = json.load(sys.stdin)
    else:
        cfg_dict = json.loads(Path(argv[1]).read_text())
    cfg = Config.from_dict(cfg_dict)
    result = score_config(cfg)

    out_path = OUT_DIR / f"autoresearch_score_{cfg.name}.json"
    out_path.write_text(json.dumps(result, indent=2, default=str))

    print(json.dumps(result, indent=2, default=str))
    primary = result.get("primary_executable_proxy", {})
    score = primary.get("delta_skill", float("nan"))
    print(f"SCORE: {score:.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
