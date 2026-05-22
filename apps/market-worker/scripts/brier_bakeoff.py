#!/usr/bin/env python3
"""Brier/reliability bakeoff for Kalshi 15-min crypto binaries.

Layer 1 of the two-layer model evaluation system (see docs).

Reads existing logs only — does NOT mutate worker state or write to live paths.
Outputs go to analysis/brier/* under the repo root.

Universes scored separately:
  A. "all_decisions"  — every validator row with a model fair_yes + Kalshi result
  B. "filled"          — only candidates that were submitted and reconciled

Layer 1 deliberately treats the strategy as a frozen black-box predictor and
asks whether any post-hoc transform of fair_yes_gaussian beats the baseline
on either universe.  No worker code is touched.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import ndtri
from scipy.stats import t as student_t
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parents[3]
LOGS = ROOT / "apps" / "market-worker" / "logs"
OUT = ROOT / "analysis" / "brier"
OUT.mkdir(parents=True, exist_ok=True)

EPS = 1e-4

# -----------------------------------------------------------------------
# Data loading
# -----------------------------------------------------------------------

def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows


def load_validator_rows() -> pd.DataFrame:
    """Universe A: every settlement-validated market where we recorded a decision."""
    rows = load_jsonl(LOGS / "kalshi-settlement-validation.jsonl")
    out = []
    for r in rows:
        if r.get("rejected_reason") is not None:
            continue
        p = r.get("our_fair_yes_at_decision")
        result = r.get("kalshi_result")
        if p is None or result not in ("yes", "no"):
            continue
        ct = pd.to_datetime(r["close_time"], utc=True)
        decision_ts = pd.to_datetime(r.get("ts"), utc=True, errors="coerce")
        if pd.notna(ct) and pd.notna(decision_ts):
            secs_to_close = max(0.0, (ct - decision_ts).total_seconds())
        else:
            secs_to_close = None
        series = r["series"]
        out.append({
            "source_table": "validator",
            "universe": "all_decisions",
            "ticker": r["ticker"],
            "series": series,
            "asset": series.replace("KX", "").replace("15M", ""),
            "close_time": ct,
            "utc_hour": ct.hour,
            "y_yes": 1 if result == "yes" else 0,
            "p_gaussian": float(p),
            "side": r.get("our_side_at_decision"),
            "executed": False,
            "ask_price": None,
            "contracts": None,
            "realized_pnl_usd": None,
            "sigma_annual": r.get("sigma_at_decision"),
            "secs_to_close": secs_to_close,
            "strike": r.get("strike"),
            "spot_source": r.get("decision_spot_source"),
            "sigma_source": r.get("decision_sigma_source"),
            "brti_window_mean": r.get("brti_window_mean"),
            "binance_window_mean": r.get("binance_window_mean"),
            "brti_matches_kalshi": r.get("brti_matches_kalshi"),
            "binance_matches_kalshi": r.get("binance_matches_kalshi"),
        })
    return pd.DataFrame(out)


def load_bakeoff_shadow(decision_secs: float = 90.0) -> pd.DataFrame:
    """Layer-2 shadow rows: model prediction + new candidate features (basis, ...).
    Each row is one scan-tick evaluation of one Kalshi market.

    For each ticker, we keep the row whose secs_to_close is the smallest value
    that is still >= decision_secs (default: 90s, matching the live executor's
    KALSHI_DEF_MIN_SECS_TO_CLOSE gate). This represents the worker's view at
    the moment a live decision would be made.

    Previously we kept the LAST row per ticker; that captured the saturation
    state (post-close), not the decision state. With the saturation row, both
    p_gaussian and any structural correction collapse to 0/1, masking the real
    signal we're trying to evaluate.

    Tickers with no row at >= decision_secs (e.g., the worker only saw them
    deep in the settlement window) are dropped."""
    rows = load_jsonl(LOGS / "kalshi-model-bakeoff-shadow.jsonl")
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    if "ticker" not in df.columns or "ts" not in df.columns:
        return pd.DataFrame()
    df["ts_parsed"] = pd.to_datetime(df["ts"], utc=True, errors="coerce")
    if "secs_to_close" not in df.columns:
        return pd.DataFrame()
    eligible = df[df["secs_to_close"] >= decision_secs].copy()
    eligible = eligible.sort_values("secs_to_close")
    eligible = eligible.drop_duplicates("ticker", keep="first")
    return eligible


def merge_layer2_with_settlements(layer2: pd.DataFrame, validator: pd.DataFrame) -> pd.DataFrame:
    """Inner join Layer-2 features with settlement labels.
    Result is one row per settled market we evaluated in shadow, with the
    basis/funding features AND y_yes from Kalshi's settlement."""
    if len(layer2) == 0 or len(validator) == 0:
        return pd.DataFrame()
    label_cols = ["ticker", "y_yes", "close_time"]
    have = validator[label_cols].drop_duplicates("ticker")
    feat = layer2[[
        "ticker", "series", "asset", "p_gaussian", "edge_gaussian",
        "spot", "strike", "sigma_annual", "secs_to_close",
        "basis_mid", "basis_bps", "funding_rate", "perp_mark", "perp_index",
        "best_yes_bid", "best_yes_ask", "best_no_bid", "best_no_ask",
        "side_gaussian",
    ]].copy()
    merged = feat.merge(have, on="ticker", how="inner")
    merged["close_time"] = pd.to_datetime(merged["close_time"], utc=True, errors="coerce")
    merged["utc_hour"] = merged["close_time"].dt.hour
    merged["universe"] = "shadow_with_basis"
    return merged


def load_filled_trades() -> pd.DataFrame:
    """Universe B: candidates the executor actually submitted, with realized PnL."""
    state_path = LOGS / "kalshi-dust-state.json"
    if not state_path.exists():
        return pd.DataFrame()
    state = json.loads(state_path.read_text())
    out = []
    for c in state.get("candidates", []):
        if c.get("status") != "filled":
            continue
        if c.get("realized_pnl_usd") is None:
            continue
        if c.get("fair_yes") is None:
            continue
        side = c.get("side")
        if side not in ("YES", "NO"):
            continue
        pnl = c["realized_pnl_usd"]
        # Reconstruct actual market outcome from side + pnl
        if side == "YES":
            y_yes = 1 if pnl > 0 else 0
        else:  # NO
            y_yes = 0 if pnl > 0 else 1
        try:
            ct = pd.to_datetime(c.get("close_time"), utc=True)
        except Exception:
            ct = pd.NaT
        series = c.get("series", "")
        out.append({
            "source_table": "dust_state_filled",
            "universe": "filled",
            "ticker": c.get("ticker"),
            "series": series,
            "asset": series.replace("KX", "").replace("15M", ""),
            "close_time": ct,
            "utc_hour": ct.hour if pd.notna(ct) else None,
            "y_yes": y_yes,
            "p_gaussian": float(c["fair_yes"]),
            "side": side,
            "executed": True,
            "ask_price": c.get("ask_price"),
            "contracts": c.get("contracts"),
            "realized_pnl_usd": pnl,
            "sigma_annual": c.get("sigma_annual"),
            "spot_source": None,
            "sigma_source": None,
            "brti_window_mean": None,
            "binance_window_mean": None,
            "brti_matches_kalshi": None,
            "binance_matches_kalshi": None,
        })
    return pd.DataFrame(out)


# -----------------------------------------------------------------------
# Scoring
# -----------------------------------------------------------------------

def brier(df: pd.DataFrame, p_col: str, y_col: str = "y_yes") -> float:
    d = df.dropna(subset=[p_col, y_col])
    if len(d) == 0:
        return float("nan")
    return float(((d[p_col] - d[y_col]) ** 2).mean())


def reliability(df: pd.DataFrame, p_col: str, y_col: str = "y_yes") -> pd.DataFrame:
    d = df.dropna(subset=[p_col, y_col]).copy()
    bins = np.arange(0.0, 1.01, 0.1)
    d["bucket"] = pd.cut(d[p_col], bins=bins, include_lowest=True, right=False)
    g = d.groupby("bucket", observed=True)
    table = pd.DataFrame({
        "n": g.size(),
        "mean_p": g[p_col].mean(),
        "actual": g[y_col].mean(),
    })
    table["gap"] = table["mean_p"] - table["actual"]
    table["brier"] = g.apply(lambda x: float(((x[p_col] - x[y_col]) ** 2).mean()))
    if df["realized_pnl_usd"].notna().any():
        table["pnl_sum"] = g["realized_pnl_usd"].sum()
    return table.reset_index()


def brier_skill(model_brier: float, baseline_brier: float) -> float:
    if baseline_brier <= 0:
        return float("nan")
    return 1 - model_brier / baseline_brier


# -----------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------

CLIP_RANGES = [(0.05, 0.95), (0.10, 0.90), (0.20, 0.80), (0.30, 0.70), (0.35, 0.65)]


def add_clip_models(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    for lo, hi in CLIP_RANGES:
        d[f"p_clip_{lo:.2f}_{hi:.2f}"] = d["p_gaussian"].clip(lo, hi)
    return d


def fit_logistic(train: pd.DataFrame) -> LogisticRegression | None:
    d = train.dropna(subset=["p_gaussian", "y_yes"])
    if len(d) < 30:
        return None
    p = np.clip(d["p_gaussian"].to_numpy(), EPS, 1 - EPS)
    X = np.log(p / (1 - p)).reshape(-1, 1)
    y = d["y_yes"].to_numpy()
    if len(np.unique(y)) < 2:
        return None
    lr = LogisticRegression()
    lr.fit(X, y)
    return lr


def apply_logistic(lr: LogisticRegression, df: pd.DataFrame) -> np.ndarray:
    p = np.clip(df["p_gaussian"].to_numpy(), EPS, 1 - EPS)
    X = np.log(p / (1 - p)).reshape(-1, 1)
    return lr.predict_proba(X)[:, 1]


def fit_logistic_with_basis(train: pd.DataFrame) -> LogisticRegression | None:
    """Logistic on logit(p_gaussian) + basis_bps + funding_rate.
    Returns None if not enough samples have non-null basis (Layer-2 data is
    only present once the shadow worker has been collecting it)."""
    needed = ["p_gaussian", "y_yes", "basis_bps", "funding_rate"]
    d = train.dropna(subset=needed)
    if len(d) < 30:
        return None
    p = np.clip(d["p_gaussian"].to_numpy(), EPS, 1 - EPS)
    logit_p = np.log(p / (1 - p))
    X = np.column_stack([
        logit_p,
        d["basis_bps"].to_numpy(),
        d["funding_rate"].to_numpy(),
    ])
    y = d["y_yes"].to_numpy()
    if len(np.unique(y)) < 2:
        return None
    lr = LogisticRegression()
    lr.fit(X, y)
    return lr


def apply_logistic_with_basis(lr: LogisticRegression, df: pd.DataFrame) -> np.ndarray:
    p = np.clip(df["p_gaussian"].to_numpy(), EPS, 1 - EPS)
    logit_p = np.log(p / (1 - p))
    basis = df["basis_bps"].fillna(0.0).to_numpy()  # neutral fill at predict time
    fund = df["funding_rate"].fillna(0.0).to_numpy()
    X = np.column_stack([logit_p, basis, fund])
    return lr.predict_proba(X)[:, 1]


# -----------------------------------------------------------------------
# Arithmetic-TWAP binary (structural-correctness candidate).
#
# Kalshi settles via a 60-second arithmetic average of BRTI. The deployed model
# prices a point digital. For tau >= delta (executor's live regime under the
# 90s gate), this reduces to an effective-time correction:
#
#     z = Phi^{-1}(p_gaussian)
#     z_twap = z * sqrt(tau / (tau - 2*delta/3))
#     p_twap = Phi(z_twap)
#
# Derivation: under driftless GBM with sigma annualized, the arithmetic
# 60-second TWAP has Var(A) approx S^2 * sigma^2 * (tau - 2*delta/3) and
# E[A] = S, which moment-matches to a lognormal with effective time
# tau_eff = tau - 2*delta/3. The single closed-form drop-in uses the same
# (S, K, sigma) implicit in p_gaussian and just rescales z.
#
# DIRECTIONALITY: for p > 0.5 (S > K), p_twap > p_gaussian. Expected to make
# the [0.7, 0.8) overconfidence bucket WORSE, not better. Included as a
# structural negative control.
# -----------------------------------------------------------------------

TWAP_DELTA_SEC = 60.0


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    from scipy.special import ndtr
    return ndtr(x)


def p_twap_asian(p_gaussian: np.ndarray, secs_to_close: np.ndarray, delta_sec: float = TWAP_DELTA_SEC) -> np.ndarray:
    """Pure transform from (p_gaussian, secs_to_close) to TWAP-corrected probability.
    For tau >= delta uses effective-time form. For tau < delta we fall back to
    p_gaussian (case-2 inside-window pricing needs the realized prefix which we
    do not log; this regime is gated out of live trading by KALSHI_DEF_MIN_SECS_TO_CLOSE=90)."""
    p = np.clip(np.asarray(p_gaussian, dtype=float), EPS, 1 - EPS)
    tau = np.asarray(secs_to_close, dtype=float)
    z = ndtri(p)
    out = p.copy()

    mask_pre = tau >= delta_sec
    tau_eff = np.where(mask_pre, tau - (2.0 / 3.0) * delta_sec, tau)
    safe = mask_pre & (tau_eff > 0)
    ratios = np.ones_like(p)
    ratios[safe] = np.sqrt(tau[safe] / tau_eff[safe])
    z_twap = z * ratios
    # Outside the pre-window regime (tau < delta) we keep p_gaussian as a
    # conservative fallback; case-2 pricing needs the realized prefix which we
    # don't log, and the live executor is gated to tau >= 90s anyway.
    return np.where(safe, _norm_cdf(z_twap), p)


# -----------------------------------------------------------------------
# Sigma-correction candidate (structural-payoff model).
#
# Tests whether the deployed BRTI 1-min realized sigma underestimates effective
# near-close variance. Functional form is rough-vol-flavored:
#
#     sigma_eff = sigma * clip(1 + a * (tau_ref / tau_sec) ** beta, 1, max_mult)
#     p = Phi(log(S/K) / (sigma_eff * sqrt(tau_years)))
#
# We grid-search (a, beta) on training rows to minimize Brier, then apply on test.
# Anchored at tau_ref = 900s (15 min) so the multiplier equals (1 + a) at the
# anchor and grows as tau shrinks. Multiplier clipped to MAX_MULT to prevent
# blow-up at very small tau (executor's 90s gate keeps live tau >= 90s anyway).
# -----------------------------------------------------------------------

SIGMA_TAU_REF_SEC = 900.0
SIGMA_MAX_MULT = 3.0
SIGMA_GRID = {
    "a": [0.0, 0.05, 0.10, 0.20, 0.40, 0.80, 1.50],
    "beta": [0.25, 0.50, 1.00, 2.00],
}
SECONDS_PER_YEAR = 365.0 * 24.0 * 3600.0


def _sigma_eff(sigma: np.ndarray, tau_sec: np.ndarray, a: float, beta: float) -> np.ndarray:
    ratio = SIGMA_TAU_REF_SEC / np.maximum(tau_sec, 1.0)
    mult = np.clip(1.0 + a * np.power(ratio, beta), 1.0, SIGMA_MAX_MULT)
    return sigma * mult


def _scale_z_by_mult(p_gaussian: np.ndarray, tau_sec: np.ndarray, a: float, beta: float) -> np.ndarray:
    """Scale the implied z = Phi^{-1}(p_gaussian) by 1/mult, where
    mult = clip(1 + a * (tau_ref/tau_sec)^beta, 1, MAX_MULT).

    This is equivalent to replacing sigma by sigma_eff = sigma * mult in the
    point-digital formula, since z = log(S/K) / (sigma * sqrt(tau)) and the
    *stored* p_gaussian already encodes the worker's full pricing (including
    any per-asset calibration), so we operate on it as a single state variable.
    If a=0 the transform is identity.
    """
    p = np.clip(np.asarray(p_gaussian, dtype=float), EPS, 1 - EPS)
    tau = np.asarray(tau_sec, dtype=float)
    z = ndtri(p)
    ratio = SIGMA_TAU_REF_SEC / np.maximum(tau, 1.0)
    mult = np.clip(1.0 + a * np.power(ratio, beta), 1.0, SIGMA_MAX_MULT)
    return _norm_cdf(z / mult)


def fit_sigma_correction(train: pd.DataFrame) -> dict | None:
    """Grid-search (a, beta) over the implied-z rescale to minimize train Brier."""
    needed = ["p_gaussian", "y_yes", "secs_to_close"]
    d = train.dropna(subset=needed)
    if len(d) < 30:
        return None
    p = d["p_gaussian"].to_numpy()
    tau = d["secs_to_close"].to_numpy()
    y = d["y_yes"].to_numpy()
    best = None
    for a in SIGMA_GRID["a"]:
        for beta in SIGMA_GRID["beta"]:
            p_pred = _scale_z_by_mult(p, tau, a, beta)
            b = float(np.mean((p_pred - y) ** 2))
            if best is None or b < best["train_brier"]:
                best = {"a": a, "beta": beta, "train_brier": b, "n_train": len(d)}
    return best


def apply_sigma_correction(params: dict, df: pd.DataFrame) -> np.ndarray:
    out = df["p_gaussian"].to_numpy().astype(float).copy()
    mask = df["secs_to_close"].notna().to_numpy()
    if mask.any():
        out[mask] = _scale_z_by_mult(
            df.loc[mask, "p_gaussian"].to_numpy(),
            df.loc[mask, "secs_to_close"].to_numpy(),
            params["a"], params["beta"],
        )
    return out


STUDENT_GRID = {
    "nu": [2, 3, 4, 5, 7, 10, 15, 30],
    "beta": [0.25, 0.40, 0.55, 0.70, 0.85, 1.00],
    "alpha": [-0.20, -0.10, 0.0, 0.10, 0.20],
}


def fit_student_t(train: pd.DataFrame) -> dict | None:
    d = train.dropna(subset=["p_gaussian", "y_yes"])
    if len(d) < 30:
        return None
    p = np.clip(d["p_gaussian"].to_numpy(), EPS, 1 - EPS)
    z = ndtri(p)
    y = d["y_yes"].to_numpy()
    best = None
    for nu in STUDENT_GRID["nu"]:
        for beta in STUDENT_GRID["beta"]:
            for alpha in STUDENT_GRID["alpha"]:
                p_pred = student_t.cdf(alpha + beta * z, df=nu)
                b = float(np.mean((p_pred - y) ** 2))
                if best is None or b < best["train_brier"]:
                    best = {
                        "nu": nu, "beta": beta, "alpha": alpha,
                        "train_brier": b, "n_train": len(d),
                    }
    return best


def apply_student_t(params: dict, df: pd.DataFrame) -> np.ndarray:
    p = np.clip(df["p_gaussian"].to_numpy(), EPS, 1 - EPS)
    z = ndtri(p)
    return student_t.cdf(params["alpha"] + params["beta"] * z, df=params["nu"])


# -----------------------------------------------------------------------
# Walk-forward
# -----------------------------------------------------------------------

@dataclass
class FoldResult:
    fold: str
    n_train: int
    n_test: int
    model: str
    brier: float
    params: dict


def walk_forward(df: pd.DataFrame, universe_label: str, with_basis: bool = False) -> pd.DataFrame:
    d = df.dropna(subset=["p_gaussian", "y_yes", "close_time"]).sort_values("close_time").reset_index(drop=True)
    n = len(d)
    if n < 80:
        return pd.DataFrame()
    cutpoints = [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 1.00)]
    results: list[dict] = []
    for train_end_frac, test_end_frac in cutpoints:
        train_end = int(n * train_end_frac)
        test_end = int(n * test_end_frac)
        train = d.iloc[:train_end]
        test = d.iloc[train_end:test_end].copy()
        if len(train) < 50 or len(test) < 10:
            continue

        # Baseline
        results.append({
            "universe": universe_label,
            "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
            "n_train": len(train),
            "n_test": len(test),
            "model": "p_gaussian",
            "brier": brier(test, "p_gaussian"),
            "params": "{}",
        })

        # Clip models (no fitting, just transforms)
        for lo, hi in CLIP_RANGES:
            col = f"p_clip_{lo:.2f}_{hi:.2f}"
            test[col] = train["p_gaussian"].clip(lo, hi)  # transform doesn't depend on train, but kept for symmetry
            test[col] = test["p_gaussian"].clip(lo, hi)
            results.append({
                "universe": universe_label,
                "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                "n_train": len(train),
                "n_test": len(test),
                "model": col,
                "brier": brier(test, col),
                "params": json.dumps({"lo": lo, "hi": hi}),
            })

        # Logistic calibration
        lr = fit_logistic(train)
        if lr is not None:
            test["p_logistic"] = apply_logistic(lr, test)
            results.append({
                "universe": universe_label,
                "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                "n_train": len(train),
                "n_test": len(test),
                "model": "p_logistic",
                "brier": brier(test, "p_logistic"),
                "params": json.dumps({
                    "intercept": float(lr.intercept_[0]),
                    "coef": float(lr.coef_[0][0]),
                }),
            })

        # Student-t
        params = fit_student_t(train)
        if params is not None:
            test["p_student_t"] = apply_student_t(params, test)
            results.append({
                "universe": universe_label,
                "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                "n_train": len(train),
                "n_test": len(test),
                "model": "p_student_t",
                "brier": brier(test, "p_student_t"),
                "params": json.dumps(params),
            })

        # Logistic + basis (Layer-2 feature-augmented)
        if with_basis:
            lr_basis = fit_logistic_with_basis(train)
            if lr_basis is not None:
                test["p_logistic_basis"] = apply_logistic_with_basis(lr_basis, test)
                results.append({
                    "universe": universe_label,
                    "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                    "n_train": len(train),
                    "n_test": len(test),
                    "model": "p_logistic_basis",
                    "brier": brier(test, "p_logistic_basis"),
                    "params": json.dumps({
                        "intercept": float(lr_basis.intercept_[0]),
                        "coef_logit_p": float(lr_basis.coef_[0][0]),
                        "coef_basis_bps": float(lr_basis.coef_[0][1]),
                        "coef_funding_rate": float(lr_basis.coef_[0][2]),
                    }),
                })

        # TWAP (structural-correctness / negative-control) — works whenever we
        # have secs_to_close. Pure transform of p_gaussian, no fit needed.
        if "secs_to_close" in test.columns and test["secs_to_close"].notna().any():
            test["p_twap"] = p_twap_asian(
                test["p_gaussian"].to_numpy(),
                test["secs_to_close"].to_numpy(),
            )
            results.append({
                "universe": universe_label,
                "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                "n_train": len(train),
                "n_test": len(test),
                "model": "p_twap",
                "brier": brier(test, "p_twap"),
                "params": json.dumps({"delta_sec": TWAP_DELTA_SEC}),
            })

        # Sigma-correction (structural-payoff candidate). Rescales implied
        # z by 1/mult(tau); needs only p_gaussian + secs_to_close.
        if "secs_to_close" in train.columns and train["secs_to_close"].notna().any():
            sig_params = fit_sigma_correction(train)
            if sig_params is not None:
                test["p_sigma_corrected"] = apply_sigma_correction(sig_params, test)
                results.append({
                    "universe": universe_label,
                    "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                    "n_train": len(train),
                    "n_test": len(test),
                    "model": "p_sigma_corrected",
                    "brier": brier(test, "p_sigma_corrected"),
                    "params": json.dumps(sig_params),
                })

                # Joint TWAP + sigma-correction: apply TWAP rescale on top of
                # sigma-corrected base. Provides attribution check.
                if "p_twap" in test.columns:
                    base = test["p_sigma_corrected"].to_numpy()
                    test["p_twap_sigma"] = p_twap_asian(
                        base, test["secs_to_close"].to_numpy(),
                    )
                    results.append({
                        "universe": universe_label,
                        "fold": f"{train_end_frac:.0%}->{test_end_frac:.0%}",
                        "n_train": len(train),
                        "n_test": len(test),
                        "model": "p_twap_sigma",
                        "brier": brier(test, "p_twap_sigma"),
                        "params": json.dumps(sig_params),
                    })

    return pd.DataFrame(results)


# -----------------------------------------------------------------------
# Slicing
# -----------------------------------------------------------------------

def by_asset(df: pd.DataFrame, p_cols: list[str]) -> pd.DataFrame:
    rows = []
    for asset, g in df.groupby("asset"):
        if len(g) < 3:
            continue
        row = {"asset": asset, "n": len(g)}
        if "realized_pnl_usd" in g and g["realized_pnl_usd"].notna().any():
            row["pnl_sum"] = float(g["realized_pnl_usd"].sum())
            row["win_rate"] = float((g["realized_pnl_usd"] > 0).mean())
        row["actual_p_yes"] = float(g["y_yes"].mean())
        for col in p_cols:
            if col in g.columns:
                row[col] = brier(g, col)
        rows.append(row)
    return pd.DataFrame(rows).sort_values("asset")


def by_hour(df: pd.DataFrame, p_cols: list[str]) -> pd.DataFrame:
    rows = []
    for hour, g in df.dropna(subset=["utc_hour"]).groupby("utc_hour"):
        if len(g) < 2:
            continue
        row = {"utc_hour": int(hour), "n": len(g)}
        if "realized_pnl_usd" in g and g["realized_pnl_usd"].notna().any():
            row["pnl_sum"] = float(g["realized_pnl_usd"].sum())
        row["actual_p_yes"] = float(g["y_yes"].mean())
        for col in p_cols:
            if col in g.columns:
                row[col] = brier(g, col)
        rows.append(row)
    return pd.DataFrame(rows).sort_values("utc_hour")


# -----------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------

def main() -> None:
    print(f"Reading logs from: {LOGS}")
    val_df = load_validator_rows()
    filled_df = load_filled_trades()
    layer2_df = load_bakeoff_shadow()
    shadow_basis_df = merge_layer2_with_settlements(layer2_df, val_df)

    print(f"  all_decisions universe:           n={len(val_df)}")
    print(f"  filled universe:                  n={len(filled_df)}")
    print(f"  layer2 shadow rows (latest/ticker): n={len(layer2_df)}")
    print(f"  shadow_with_basis (joined w/settlement): n={len(shadow_basis_df)}")

    # Add transform-only models to both universes (clip variants)
    val_df = add_clip_models(val_df)
    filled_df = add_clip_models(filled_df)

    # In-sample logistic + Student-t fits (for full-data baseline; walk-forward is below)
    lr_all = fit_logistic(val_df)
    if lr_all is not None:
        val_df["p_logistic_insample"] = apply_logistic(lr_all, val_df)
    st_all = fit_student_t(val_df)
    if st_all is not None:
        val_df["p_student_t_insample"] = apply_student_t(st_all, val_df)

    lr_filled = fit_logistic(filled_df)
    if lr_filled is not None:
        filled_df["p_logistic_insample"] = apply_logistic(lr_filled, filled_df)
    st_filled = fit_student_t(filled_df)
    if st_filled is not None:
        filled_df["p_student_t_insample"] = apply_student_t(st_filled, filled_df)

    # Summary (in-sample) — useful as a baseline reproduction
    summary = []
    for universe_name, df in [("all_decisions", val_df), ("filled", filled_df)]:
        if len(df) == 0:
            continue
        baseline_p = df["y_yes"].mean()
        climatology = float(((baseline_p - df["y_yes"]) ** 2).mean())
        for col in [c for c in df.columns if c.startswith("p_")]:
            score = brier(df, col)
            if math.isnan(score):
                continue
            summary.append({
                "universe": universe_name,
                "model": col,
                "n": int(df[[col, "y_yes"]].dropna().shape[0]),
                "brier": score,
                "climatology_brier": climatology,
                "brier_skill_vs_climatology": brier_skill(score, climatology),
                "fit": "in-sample" if col.endswith("_insample") else "transform" if col.startswith("p_clip") else "raw",
            })
    summary_df = pd.DataFrame(summary)
    summary_df.to_csv(OUT / "brier_summary.csv", index=False)

    # Reliability tables per universe
    reliability(val_df, "p_gaussian").to_csv(OUT / "reliability_all_decisions.csv", index=False)
    reliability(filled_df, "p_gaussian").to_csv(OUT / "reliability_filled.csv", index=False)

    # Walk-forward — the honest test
    wf_val = walk_forward(val_df, "all_decisions")
    wf_filled = walk_forward(filled_df, "filled")
    wf_shadow_basis = walk_forward(shadow_basis_df, "shadow_with_basis", with_basis=True) if len(shadow_basis_df) >= 80 else pd.DataFrame()
    wf_combined = pd.concat([wf_val, wf_filled, wf_shadow_basis], ignore_index=True)
    wf_combined.to_csv(OUT / "bakeoff_walk_forward.csv", index=False)

    # Walk-forward summary (mean Brier per model per universe)
    if len(wf_combined) > 0:
        wf_agg = wf_combined.groupby(["universe", "model"]).agg(
            n_folds=("brier", "size"),
            mean_brier=("brier", "mean"),
            min_brier=("brier", "min"),
            max_brier=("brier", "max"),
        ).reset_index()
        wf_agg.to_csv(OUT / "bakeoff_walk_forward_summary.csv", index=False)
    else:
        wf_agg = pd.DataFrame()

    # By-asset and by-hour Brier for each universe
    base_cols = ["p_gaussian"] + [f"p_clip_{lo:.2f}_{hi:.2f}" for lo, hi in CLIP_RANGES]
    if "p_logistic_insample" in val_df.columns:
        base_cols.append("p_logistic_insample")
    if "p_student_t_insample" in val_df.columns:
        base_cols.append("p_student_t_insample")

    bakeoff_by_asset = pd.concat([
        by_asset(val_df, base_cols).assign(universe="all_decisions"),
        by_asset(filled_df, base_cols).assign(universe="filled"),
    ], ignore_index=True)
    bakeoff_by_asset.to_csv(OUT / "bakeoff_by_asset.csv", index=False)

    bakeoff_by_hour = pd.concat([
        by_hour(val_df, base_cols).assign(universe="all_decisions"),
        by_hour(filled_df, base_cols).assign(universe="filled"),
    ], ignore_index=True)
    bakeoff_by_hour.to_csv(OUT / "bakeoff_by_hour.csv", index=False)

    # Top-line JSON
    topline = {
        "n_all_decisions": int(len(val_df)),
        "n_filled": int(len(filled_df)),
        "filled_baseline_p_yes": float(filled_df["y_yes"].mean()) if len(filled_df) else None,
        "filled_climatology_brier": float(
            ((filled_df["y_yes"].mean() - filled_df["y_yes"]) ** 2).mean()
        ) if len(filled_df) else None,
        "filled_gaussian_brier": brier(filled_df, "p_gaussian") if len(filled_df) else None,
        "all_decisions_baseline_p_yes": float(val_df["y_yes"].mean()) if len(val_df) else None,
        "all_decisions_gaussian_brier": brier(val_df, "p_gaussian") if len(val_df) else None,
        "student_t_full_fit_validator": st_all,
        "student_t_full_fit_filled": st_filled,
        "outputs_dir": str(OUT),
    }
    (OUT / "brier_summary.json").write_text(json.dumps(topline, indent=2, default=str))

    # Console report
    print()
    print("=" * 78)
    print("SUMMARY (in-sample Brier per model, per universe)")
    print("=" * 78)
    if len(summary_df):
        print(summary_df.sort_values(["universe", "brier"]).to_string(index=False))
    print()
    if len(wf_agg):
        print("=" * 78)
        print("WALK-FORWARD aggregated Brier (out-of-sample, sorted by mean_brier)")
        print("=" * 78)
        print(wf_agg.sort_values(["universe", "mean_brier"]).to_string(index=False))
    print()
    print(f"Wrote outputs to {OUT}")


if __name__ == "__main__":
    main()
