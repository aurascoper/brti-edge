#!/usr/bin/env python3
"""Recompute per-asset YES bias from settled trades while excluding W2PP holdout.

bias[asset] = mean(actual_yes - model_fair_yes_at_emit)

Positive bias means the model understates YES probability for this asset.
The strategy applies: fair_yes_corrected = clamp(fair_yes + alpha * bias, 0.05, 0.95)
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from w2pp_holdout_guard import W2PP_DECLARATION_TAG, filter_out_w2pp_holdout  # noqa: E402

WORKER_DIR = SCRIPT_DIR.parent
STATE = WORKER_DIR / "logs" / "kalshi-dust-state.json"
OUT = WORKER_DIR / "logs" / "calibration.json"
MIN_N = 5


def recompute_calibration(
    state_path: Path = STATE,
    out_path: Path = OUT,
    *,
    min_n: int = MIN_N,
) -> dict[str, Any]:
    d = json.loads(state_path.read_text(encoding="utf-8"))
    raw_filled = [
        c
        for c in d.get("candidates", [])
        if c.get("status") == "filled"
        and c.get("realized_pnl_usd") is not None
        and str(c.get("ticker", "")).startswith("KX")
        and c.get("fair_yes") is not None
    ]
    filled, excluded_w2pp = filter_out_w2pp_holdout(raw_filled)

    samples: dict[str, list[float]] = defaultdict(list)
    for c in filled:
        fair = float(c["fair_yes"])
        won = float(c.get("realized_pnl_usd", 0.0)) > 0.0
        side = c["side"]
        actual_yes = 1 if (side == "YES" and won) or (side == "NO" and not won) else 0
        samples[str(c["series"])].append(actual_yes - fair)

    out: dict[str, Any] = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "min_sample_n": min_n,
        "w2pp_holdout_tag_excluded": W2PP_DECLARATION_TAG,
        "w2pp_holdout_excluded_count": excluded_w2pp,
        "bias_by_series": {},
        "sample_sizes": {},
    }
    for s, vals in samples.items():
        n = len(vals)
        out["sample_sizes"][s] = n
        if n >= min_n:
            out["bias_by_series"][s] = round(sum(vals) / n, 4)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return out


def main() -> int:
    if not STATE.exists():
        print(f"State file not found: {STATE}")
        return 0
    out = recompute_calibration(STATE, OUT)
    print(f"Wrote {OUT} (excluded {out['w2pp_holdout_excluded_count']} W2PP holdout rows)")
    for s, b in sorted(out["bias_by_series"].items()):
        n = out["sample_sizes"][s]
        print(f"  {s:<11} n={n:<3} bias={b:+.4f}")
    hidden = {s: n for s, n in out["sample_sizes"].items() if s not in out["bias_by_series"]}
    if hidden:
        print(f"  (insufficient sample, excluded: {hidden})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
