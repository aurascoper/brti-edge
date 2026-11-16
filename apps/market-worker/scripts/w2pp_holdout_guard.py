"""W2PP holdout partition guard (2026-09-24T17:00:00Z .. 2026-10-08T17:00:00Z).

Enforces Issue #18 non-negotiable holdout isolation: rows or CLI spans touching the
locked w2pp-declaration-20260924 / w2pp-instrument-20260924 window must never
be silently reused for calibration, bakeoff fitting, fade sensitivity, or autoresearch tuning.
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

DEFAULT_TS_KEYS: tuple[str, ...] = (
    "close_time",
    "ts",
    "ts_ms",
    "recv_ts_ms",
    "ingest_ts",
    "src_ts",
    "settled_at",
    "created_at",
    "updated_at",
    "expiration_time",
    "open_time",
    "timestamp",
    "event_ts",
)


class W2PPHoldoutOverlapError(RuntimeError):
    """Raised when a requested evaluation/calibration span overlaps the locked W2PP holdout."""


def _numeric_epoch_to_ms(val_f: float) -> int | None:
    if math.isnan(val_f) or math.isinf(val_f) or val_f <= 0:
        return None
    if val_f < 1e11:
        return round(val_f * 1000.0)
    if val_f < 1e14:
        return round(val_f)
    if val_f < 1e17:
        return round(val_f / 1000.0)
    return round(val_f / 1_000_000.0)


def parse_timestamp_ms(value: Any) -> int | None:
    """Parse ISO-8601 string, numeric string, datetime/Timestamp, or epoch s/ms/us/ns to UTC ms."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _numeric_epoch_to_ms(float(value))
    if isinstance(value, datetime):
        dt = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return _numeric_epoch_to_ms(float(dt.timestamp()))
    if hasattr(value, "timestamp"):
        try:
            ts = float(value.timestamp())
            return _numeric_epoch_to_ms(ts)
        except (ValueError, TypeError, OSError, OverflowError):
            return None
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return _numeric_epoch_to_ms(float(s))
        except ValueError:
            pass
        if s.endswith(("Z", "z")):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return round(dt.timestamp() * 1000.0)
        except ValueError:
            return None
    return None


def is_in_w2pp_holdout(value: Any, *, fail_closed_on_unparseable: bool = False) -> bool:
    """Return True iff timestamp falls inside [2026-09-24T17:00:00Z, 2026-10-08T17:00:00Z]."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return False
    ts_ms = parse_timestamp_ms(value)
    if ts_ms is None:
        return fail_closed_on_unparseable
    return W2PP_HOLDOUT_START_MS <= ts_ms <= W2PP_HOLDOUT_END_MS


def _has_present_value(value: Any) -> bool:
    if value is None:
        return False
    return not (isinstance(value, str) and not value.strip())


def row_overlaps_w2pp_holdout(
    row: dict[str, Any],
    *,
    ts_keys: tuple[str, ...] = DEFAULT_TS_KEYS,
    fail_closed_on_unparseable: bool = True,
) -> bool:
    """Return True if any timestamp field on row (or nested raw.msg) overlaps W2PP holdout.

    When fail_closed_on_unparseable is True (default), a non-empty timestamp value that
    cannot be parsed is treated as quarantined so corrupt formats cannot bypass filtering.
    """
    candidates: list[dict[str, Any]] = [row]
    raw_obj = row.get("raw")
    if isinstance(raw_obj, dict):
        candidates.append(raw_obj)
        msg_obj = raw_obj.get("msg")
        if isinstance(msg_obj, dict):
            candidates.append(msg_obj)

    for mapping in candidates:
        for key in ts_keys:
            if key not in mapping:
                continue
            val = mapping.get(key)
            if not _has_present_value(val):
                continue
            ts_ms = parse_timestamp_ms(val)
            if ts_ms is None:
                if fail_closed_on_unparseable:
                    return True
                continue
            if W2PP_HOLDOUT_START_MS <= ts_ms <= W2PP_HOLDOUT_END_MS:
                return True
    return False


def filter_out_w2pp_holdout(
    rows: Iterable[dict[str, Any]],
    *,
    ts_keys: tuple[str, ...] = DEFAULT_TS_KEYS,
    allow_locked_w2pp_holdout: bool = False,
    fail_closed_on_unparseable: bool = True,
) -> tuple[list[dict[str, Any]], int]:
    """Filter rows excluding the locked W2PP holdout unless explicitly authorized for audit."""
    items = list(rows)
    if allow_locked_w2pp_holdout:
        return items, 0
    kept: list[dict[str, Any]] = []
    excluded = 0
    for row in items:
        if row_overlaps_w2pp_holdout(
            row,
            ts_keys=ts_keys,
            fail_closed_on_unparseable=fail_closed_on_unparseable,
        ):
            excluded += 1
        else:
            kept.append(row)
    return kept, excluded


def filter_dataframe_w2pp_holdout(
    df: Any,
    *,
    ts_keys: tuple[str, ...] = DEFAULT_TS_KEYS,
    allow_locked_w2pp_holdout: bool = False,
    fail_closed_on_unparseable: bool = True,
) -> tuple[Any, int]:
    """Filter a pandas DataFrame (duck-typed, stdlib-only) across all matching timestamp columns."""
    if allow_locked_w2pp_holdout or len(df) == 0:
        return df, 0
    present_cols = [col for col in ts_keys if col in df.columns]
    if not present_cols:
        return df, 0

    def _cell_quarantined(val: Any) -> bool:
        if val is None or (isinstance(val, float) and math.isnan(val)):
            return False
        if isinstance(val, str) and not val.strip():
            return False
        return is_in_w2pp_holdout(val, fail_closed_on_unparseable=fail_closed_on_unparseable)

    mask = df[present_cols[0]].map(_cell_quarantined)
    for col in present_cols[1:]:
        mask = mask | df[col].map(_cell_quarantined)
    excluded = int(mask.sum())
    return df[~mask].reset_index(drop=True), excluded



def assert_span_excludes_w2pp_holdout(
    since: Any,
    until: Any,
    *,
    allow_locked_w2pp_holdout: bool = False,
) -> tuple[int, int]:
    """Validate [since, until] and raise W2PPHoldoutOverlapError on overlap with W2PP holdout."""
    t0 = parse_timestamp_ms(since)
    t1 = parse_timestamp_ms(until)
    if t0 is None or t1 is None:
        raise W2PPHoldoutOverlapError(
            f"Unparseable span boundary (fail-closed under W2PP guard): since={since!r}, until={until!r}"
        )
    if t0 > t1:
        raise W2PPHoldoutOverlapError(f"Invalid span since > until: {since!r} > {until!r}")
    if not allow_locked_w2pp_holdout and t0 <= W2PP_HOLDOUT_END_MS and t1 >= W2PP_HOLDOUT_START_MS:
        raise W2PPHoldoutOverlapError(
            f"Requested span [{since!r}, {until!r}] overlaps locked W2PP holdout "
            f"[{W2PP_HOLDOUT_START_ISO}, {W2PP_HOLDOUT_END_ISO}] ({W2PP_DECLARATION_TAG})."
        )
    return t0, t1
