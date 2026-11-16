"""G0 verification for brti-edge: cross-repo .env isolation and W2PP holdout exclusion."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "apps" / "market-worker" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import compute_calibration
from w2pp_holdout_guard import (
    W2PP_HOLDOUT_END_ISO,
    W2PP_HOLDOUT_START_ISO,
    filter_out_w2pp_holdout,
    is_in_w2pp_holdout,
)


def test_zero_cross_repo_live_trading_dotenv_or_dangling_polyterminal_paths() -> None:
    remediated_files = (
        "apps/market-worker/src/kalshi/worker.ts",
        "apps/data-collector/src/index.ts",
        "apps/market-worker/src/kalshi/check_pos.ts",
        "packages/kalshi-client/src/smoke.ts",
        "packages/kalshi-client/src/smoke-adapter.ts",
        "packages/kalshi-client/src/smoke-multi-series.ts",
        "apps/market-worker/scripts/run-worker-shadow.sh",
        "apps/data-collector/scripts/run-collector-supervised.sh",
        "apps/market-worker/scripts/compute_calibration.py",
        "apps/market-worker/scripts/w2pp_holdout_guard.py",
    )
    forbidden = (
        "live_trading/.env",
        "loadEnvFromLiveTrading",
        "/Developer/polyterminal",
    )
    for rel in remediated_files:
        txt = (REPO_ROOT / rel).read_text(encoding="utf-8")
        for pat in forbidden:
            assert pat not in txt, f"Forbidden cross-repo coupling {pat!r} found in {rel}"


def test_w2pp_holdout_exact_window_boundaries() -> None:
    assert W2PP_HOLDOUT_START_ISO == "2026-09-24T17:00:00Z"
    assert W2PP_HOLDOUT_END_ISO == "2026-10-08T17:00:00Z"

    assert is_in_w2pp_holdout("2026-09-24T16:59:59Z") is False
    assert is_in_w2pp_holdout("2026-09-24T17:00:00Z") is True
    assert is_in_w2pp_holdout("2026-10-01T12:00:00Z") is True
    assert is_in_w2pp_holdout("2026-10-08T17:00:00Z") is True
    assert is_in_w2pp_holdout("2026-10-08T17:00:01Z") is False

    rows = [
        {"ticker": "PRE", "close_time": "2026-09-24T16:59:00Z"},
        {"ticker": "IN_HOLD_1", "close_time": "2026-09-24T17:00:00Z"},
        {"ticker": "IN_HOLD_2", "ts": "2026-10-08T17:00:00Z"},
        {"ticker": "POST", "close_time": "2026-10-08T17:15:00Z"},
    ]
    kept, excluded = filter_out_w2pp_holdout(rows)
    assert excluded == 2
    assert [r["ticker"] for r in kept] == ["PRE", "POST"]


def test_compute_calibration_excludes_w2pp_holdout_rows(tmp_path: Path) -> None:
    state_file = tmp_path / "kalshi-dust-state.json"
    out_file = tmp_path / "calibration.json"
    candidates = [
        # 5 pre-holdout filled trades with actual_yes=1, fair_yes=0.4 -> bias +0.6000
        *[
            {
                "status": "filled",
                "ticker": f"KXBTC15M-PRE-{i}",
                "series": "KXBTC15M",
                "side": "YES",
                "fair_yes": 0.4,
                "realized_pnl_usd": 0.5,
                "close_time": "2026-09-20T12:00:00Z",
            }
            for i in range(5)
        ],
        # 5 W2PP holdout trades with opposite outcome that MUST be excluded
        *[
            {
                "status": "filled",
                "ticker": f"KXBTC15M-W2PP-{i}",
                "series": "KXBTC15M",
                "side": "YES",
                "fair_yes": 0.9,
                "realized_pnl_usd": -0.9,
                "close_time": "2026-09-30T12:00:00Z",
            }
            for i in range(5)
        ],
    ]
    state_file.write_text(json.dumps({"candidates": candidates}), encoding="utf-8")
    res = compute_calibration.recompute_calibration(state_file, out_file, min_n=5)
    assert res["w2pp_holdout_excluded_count"] == 5
    assert res["sample_sizes"]["KXBTC15M"] == 5
    assert res["bias_by_series"]["KXBTC15M"] == 0.6
