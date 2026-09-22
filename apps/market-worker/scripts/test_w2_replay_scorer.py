#!/usr/bin/env python3
"""Checks for the W2″ scorer guards: an unreadable row ends no run, and a ticker
is scored only under its own series (prereg §3 strata, §8 unit of n).

Run: python3 apps/market-worker/scripts/test_w2_replay_scorer.py (pytest works too).
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("w2rs", os.path.join(HERE, "w2_replay_scorer.py"))
w2rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w2rs)

SINCE, UNTIL = "2026-09-24T10:00:00Z", "2026-09-24T12:00:00Z"
GOOD = [("KXBTC15M-26SEP2410{}-30".format(m), "2026-09-24T10:{}:00Z".format(m)) for m in ("15", "30", "45")]
BAD_TICKER = ("KXBTC15M26SEP241100-30", "2026-09-24T11:00:00Z")   # no hyphen after the series
UNREADABLE = ("KXBTC15M-26AUG131000-30", "not-a-date")            # an earlier window's row


def shadow_rows(ticker, minute, series="KXBTC15M"):
    """A first fire at the ask, then a next row at the same ask, so it fills."""
    base = dict(ticker=ticker, series=series, side="YES", best_yes_ask=0.40,
                best_no_ask=0.62, best_yes_bid=0.38, fair_yes=0.55)
    return [dict(base, ts=f"2026-09-24T10:{minute}:00Z"), dict(base, ts=f"2026-09-24T10:{minute}:15Z")]


def run(settlements, rows, listing):
    """Run the scorer over fixtures in a temp log directory; return its stdout."""
    logs, argv = w2rs.LOGS, sys.argv
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "kalshi-settlement-validation.jsonl"), "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in settlements)
        with open(os.path.join(tmp, "kalshi-shadow.jsonl"), "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in rows)
        listing_path = os.path.join(tmp, "listing.json")
        with open(listing_path, "w") as f:
            json.dump(listing, f)
        w2rs.LOGS = tmp
        sys.argv = ["w2_replay_scorer.py", "--since", SINCE, "--until", UNTIL,
                    "--settled-listing", listing_path]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                w2rs.main()
        finally:
            w2rs.LOGS, sys.argv = logs, argv
    return out.getvalue()


def filled(stdout):
    m = re.search(r"first-fire signals: (\d+)\s+filled: (\d+)", stdout)
    assert m, stdout
    return int(m.group(1)), int(m.group(2))


def fixtures(*extra_tickers):
    settlements = [{"ticker": t, "close_time": c, "kalshi_result": "yes"} for t, c in GOOD + list(extra_tickers)]
    rows = [r for t, c in GOOD for r in shadow_rows(t, c[14:16])]
    for t, c in extra_tickers:
        rows += shadow_rows(t, "00" if c == "not-a-date" else c[14:16])
    listing = [{"ticker": t, "close_time": c, "result": "yes"} for t, c in GOOD]
    return settlements, rows, listing


def test_three_good_tickers_are_scored():
    assert filled(run(*fixtures())) == (3, 3)


def test_an_unreadable_close_time_does_not_end_the_run():
    # Before the guard this raised ValueError, and the close wrapper turned the
    # scorer's non-zero exit into NO-GO (integrity) on a healthy window.
    assert filled(run(*fixtures(UNREADABLE))) == (3, 3)


def test_a_ticker_outside_its_series_is_not_scored():
    # Reconciliation skips this ticker, so scoring it would put an unreconciled
    # settlement into S1's n.
    assert filled(run(*fixtures(BAD_TICKER))) == (3, 3)


def test_an_unreadable_shadow_timestamp_does_not_end_the_run():
    settlements, rows, listing = fixtures()
    rows.append(dict(ticker=GOOD[0][0], series="KXBTC15M", side="YES", ts="not-a-date",
                     best_yes_ask=0.40, best_no_ask=0.62, best_yes_bid=0.38, fair_yes=0.55))
    assert filled(run(settlements, rows, listing)) == (3, 3)


def test_both_poison_rows_together_change_nothing():
    assert filled(run(*fixtures(UNREADABLE, BAD_TICKER))) == (3, 3)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"{len(tests)} checks passed")
