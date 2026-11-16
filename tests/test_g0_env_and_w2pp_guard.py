"""G0 verification for brti-edge: cross-repo .env isolation and complete W2PP holdout coverage."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "apps" / "market-worker" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import compute_calibration
from w2pp_holdout_guard import (
    DEFAULT_TS_KEYS,
    W2PP_HOLDOUT_END_ISO,
    W2PP_HOLDOUT_END_MS,
    W2PP_HOLDOUT_START_ISO,
    W2PP_HOLDOUT_START_MS,
    W2PPHoldoutOverlapError,
    assert_span_excludes_w2pp_holdout,
    filter_out_w2pp_holdout,
    is_in_w2pp_holdout,
    parse_timestamp_ms,
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


def test_w2pp_holdout_all_timestamp_representations_and_fail_closed() -> None:
    assert W2PP_HOLDOUT_START_ISO == "2026-09-24T17:00:00Z"
    assert W2PP_HOLDOUT_END_ISO == "2026-10-08T17:00:00Z"

    # Millisecond-exact boundaries
    assert is_in_w2pp_holdout(W2PP_HOLDOUT_START_MS - 1) is False
    assert is_in_w2pp_holdout(W2PP_HOLDOUT_START_MS) is True
    assert is_in_w2pp_holdout(W2PP_HOLDOUT_END_MS) is True
    assert is_in_w2pp_holdout(W2PP_HOLDOUT_END_MS + 1) is False

    # Every supported timestamp format inside the holdout window (2026-10-01T12:00:00Z)
    mid_s = 1790856000
    mid_ms = mid_s * 1000
    mid_us = mid_ms * 1000
    mid_ns = mid_us * 1000
    in_holdout_representations: list[object] = [
        "2026-10-01T12:00:00Z",
        "2026-10-01T12:00:00.000000z",
        "2026-10-01T07:00:00-05:00",
        "2026-10-01 12:00:00+00:00",
        "2026-10-01 12:00:00",
        datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC),
        datetime(2026, 10, 1, 12, 0, 0),
        mid_s,
        float(mid_s) + 0.25,
        mid_ms,
        mid_us,
        mid_ns,
        str(mid_s),
        f"{mid_s}.5",
        str(mid_ms),
        str(mid_us),
        str(mid_ns),
    ]
    for rep in in_holdout_representations:
        assert is_in_w2pp_holdout(rep) is True, f"Failed to flag holdout representation {rep!r}"

    # Malformed, NaN, Inf, and bool values fail closed during row filtering
    assert parse_timestamp_ms(True) is None
    assert parse_timestamp_ms(False) is None
    assert parse_timestamp_ms(float("nan")) is None
    assert parse_timestamp_ms(float("inf")) is None
    assert parse_timestamp_ms("not-a-timestamp") is None

    malformed_rows = [
        {"ticker": "CLEAN_PRE", "close_time": "2026-09-20T00:00:00Z"},
        {"ticker": "BAD_STR", "ts": "corrupt-iso-value"},
        {"ticker": "BAD_NAN", "recv_ts_ms": float("nan")},
        {"ticker": "BAD_BOOL", "ingest_ts": True},
        {"ticker": "NESTED_HOLD", "raw": {"msg": {"ts": str(mid_ms)}}},
    ]
    kept, excluded = filter_out_w2pp_holdout(malformed_rows)
    assert excluded == 4
    assert [r["ticker"] for r in kept] == ["CLEAN_PRE"]

    # Every key in DEFAULT_TS_KEYS triggers exclusion
    for key in DEFAULT_TS_KEYS:
        k_rows, k_excl = filter_out_w2pp_holdout([{key: mid_ms}])
        assert k_excl == 1 and k_rows == [], f"Key {key!r} failed W2PP filtering"


def test_span_overlap_guard_and_w1_fade_audit_cli() -> None:
    # Disjoint pre and post spans pass
    assert assert_span_excludes_w2pp_holdout("2026-08-02T04:16:00Z", "2026-08-03T18:37:03Z") == (
        1785644160000,
        1785782223000,
    )
    assert assert_span_excludes_w2pp_holdout("2026-10-08T17:00:01Z", "2026-10-10T00:00:00Z")[0] > W2PP_HOLDOUT_END_MS

    # Partial, boundary-touching, and enclosing spans raise W2PPHoldoutOverlapError
    overlapping_spans = (
        ("2026-09-20T00:00:00Z", "2026-09-24T17:00:00Z"),
        ("2026-09-25T00:00:00Z", "2026-09-26T00:00:00Z"),
        ("2026-10-08T17:00:00Z", "2026-10-12T00:00:00Z"),
        ("2026-09-01T00:00:00Z", "2026-10-20T00:00:00Z"),
    )
    for s0, s1 in overlapping_spans:
        with pytest.raises(W2PPHoldoutOverlapError):
            assert_span_excludes_w2pp_holdout(s0, s1)

    # CLI execution of w1_fade_audit.py rejects an overlapping W2PP span before reading logs
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "w1_fade_audit.py"),
            "--since",
            "2026-09-25T00:00:00Z",
            "--until",
            "2026-09-26T00:00:00Z",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "W2PPHoldoutOverlapError" in proc.stderr


def test_repository_wide_python_scoring_and_calibration_guard_completeness() -> None:
    """Every non-frozen fitting/calibration/audit Python script in brti-edge must wire w2pp_holdout_guard."""
    proc = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "*.py"],
        capture_output=True,
        text=True,
        check=True,
    )
    tracked_py = sorted(line.strip() for line in proc.stdout.splitlines() if line.strip())
    assert tracked_py, "Expected tracked Python scripts in brti-edge"

    # Explicit non-fitting allowlist:
    # - Official frozen holdout close protocol & replay scorer (must NOT filter out the window they close)
    # - Pure RNG synthetic Monte Carlo (zero empirical data reads)
    # - External HuggingFace bootstrap converter (stamps bootstrap_only=True) & L1 mirror health check
    # - Guard module itself and test suites
    exempt_non_fitting = {
        "apps/data-collector/scripts/convert_openmarket_corpus.py",
        "apps/data-collector/scripts/pm_mirror_check.py",
        "apps/market-worker/scripts/oc_monte_carlo.py",
        "apps/market-worker/scripts/test_w2_close_check.py",
        "apps/market-worker/scripts/w2_close_check.py",
        "apps/market-worker/scripts/w2_replay_scorer.py",
        "apps/market-worker/scripts/w2pp_holdout_guard.py",
        "tests/test_g0_env_and_w2pp_guard.py",
    }
    expected_guarded = {
        "apps/market-worker/scripts/brier_bakeoff.py",
        "apps/market-worker/scripts/compute_calibration.py",
        "apps/market-worker/scripts/w1_fade_audit.py",
        "autoresearch_caps/score.py",
        "autoresearch_layer2/score.py",
    }

    unguarded: list[str] = []
    guarded_seen: set[str] = set()
    for rel in tracked_py:
        if rel in exempt_non_fitting:
            continue
        src = (REPO_ROOT / rel).read_text(encoding="utf-8")
        if "w2pp_holdout_guard" in src and any(
            fn in src
            for fn in (
                "filter_out_w2pp_holdout",
                "filter_dataframe_w2pp_holdout",
                "assert_span_excludes_w2pp_holdout",
            )
        ):
            guarded_seen.add(rel)
        else:
            unguarded.append(rel)

    assert not unguarded, f"Unguarded Python scoring/calibration scripts detected: {unguarded}"
    assert expected_guarded.issubset(guarded_seen)


def test_compute_calibration_excludes_w2pp_holdout_rows(tmp_path: Path) -> None:
    state_file = tmp_path / "kalshi-dust-state.json"
    out_file = tmp_path / "calibration.json"
    candidates = [
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
