"""W2PP holdout partition guard (2026-09-24T17:00:00Z .. 2026-10-08T17:00:00Z).

Enforces Issue #18 non-negotiable holdout isolation: rows falling inside the
locked w2pp-declaration-20260924 / w2pp-instrument-20260924 window must never
be silently reused for calibration, bakeoff fitting, or autoresearch tuning.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

W2PP_DECLARATION_TAG = "w2pp-declaration-20260924"
W2PP_INSTRUMENT_TAG = "w2pp-instrument-20260924"
W2PP_HOLDOUT_START_ISO = "2026-09-24T17:00:00Z"
W2PP_HOLDOUT_END_ISO = "2026-10-08T17:00:00Z"
W2PP_HOLDOUT_START_MS = 1790269200000
W2PP_HOLDOUT_END_MS = 1791478800000


def parse_timestamp_ms(value: Any) -> int | None:
    """Parse ISO-8601 string, datetime, pandas Timestamp, or epoch s/ms to UTC ms."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        val_f = float(value)
        if math.isnan(val_f) or val_f <= 0:
            return None
        return round(val_f * 1000.0) if val_f < 1e11 else round(val_f)
    if hasattr(value, "timestamp"):
        try:
            ts = float(value.timestamp())
            if math.isnan(ts):
                return None
            return round(ts * 1000.0)
        except (ValueError, TypeError, OSError, OverflowError):
            return None
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return round(dt.timestamp() * 1000.0)
        except ValueError:
            return None
    return None


def is_in_w2pp_holdout(value: Any) -> bool:
    """Return True iff timestamp falls inside [2026-09-24T17:00:00Z, 2026-10-08T17:00:00Z]."""
    ts_ms = parse_timestamp_ms(value)
    if ts_ms is None:
        return False
    return W2PP_HOLDOUT_START_MS <= ts_ms <= W2PP_HOLDOUT_END_MS


def row_overlaps_w2pp_holdout(
    row: dict[str, Any],
    *,
    ts_keys: tuple[str, ...] = ("close_time", "ts", "settled_at", "created_at", "updated_at"),
) -> bool:
    """Return True if any timestamp field on row falls within the locked W2PP holdout window."""
    return any(key in row and is_in_w2pp_holdout(row.get(key)) for key in ts_keys)


def filter_out_w2pp_holdout(
    rows: Iterable[dict[str, Any]],
    *,
    ts_keys: tuple[str, ...] = ("close_time", "ts", "settled_at", "created_at", "updated_at"),
    allow_locked_w2pp_holdout: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    """Filter rows excluding the locked W2PP holdout unless explicitly authorized for audit."""
    items = list(rows)
    if allow_locked_w2pp_holdout:
        return items, 0
    kept: list[dict[str, Any]] = []
    excluded = 0
    for row in items:
        if row_overlaps_w2pp_holdout(row, ts_keys=ts_keys):
            excluded += 1
        else:
            kept.append(row)
    return kept, excluded
