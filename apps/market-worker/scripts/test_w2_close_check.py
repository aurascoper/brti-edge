#!/usr/bin/env python3
"""Checks for the W2″ exchange-open-time amendment to w2_close_check.py.

Fixtures are committed evidence: the archived W2′ settled listing and the gap
records in the W2″ precommit (Aug 13) and the W2′ close report (Aug 17/19/20).
Run: python3 apps/market-worker/scripts/test_w2_close_check.py (pytest works too).
"""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("w2cc", os.path.join(HERE, "w2_close_check.py"))
w2cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w2cc)
ms, iso = w2cc.ts_ms, w2cc.iso_utc

LISTING = os.path.join(w2cc.ANALYSIS_W2, "settled-listing-2026-08-06-2026-08-20.json")
T0, T1 = ms("2026-08-06T10:00:00Z"), ms("2026-08-20T10:00:00Z")   # W2′ span
AUG13 = ("2026-08-13T06:45:12Z", "2026-08-13T09:00:10Z")  # precommit §1
AUG17 = ("2026-08-17T11:16:48Z", "2026-08-17T14:06:21Z")  # close report [1]
AUG19 = ("2026-08-19T12:15:08Z", "2026-08-19T14:58:47Z")  # close report [1]
AUG20 = ("2026-08-20T06:45:23Z", "2026-08-20T09:00:35Z")  # close report [1]


def listing():
    with open(LISTING) as f:
        return json.load(f)


def rows_except(*gaps):
    """A 15 s scan stream over the span, with no rows strictly inside each gap."""
    spans = [(ms(a), ms(b)) for a, b in gaps]
    out = [t for t in range(int(T0), int(T1) + 1, 15_000)
           if not any(a < t < b for a, b in spans)]
    return sorted(out + [t for s in spans for t in s])


def hours_except(*missing):
    have = set()
    t = T0
    while t < T1:
        have.add(iso(t)[:13])
        t += 3_600_000
    return {c: have - set(missing) for c in w2cc.CHANNELS}


def test_wrapper_is_frozen():
    assert "apps/market-worker/scripts/w2_close_check.py" in w2cc.FROZEN_PATHS


def test_env_vector_file_is_frozen_and_names_only_vector_keys():
    rel = "apps/market-worker/scripts/w2pp-env-vector.json"
    assert rel in w2cc.FROZEN_PATHS
    with open(os.path.join(w2cc.REPO, rel)) as f:
        v = json.load(f)
    assert set(v) <= set(w2cc.ENV_VECTOR_KEYS) and v["KALSHI_API_BASE"] == w2cc.API_BASE_DEFAULT, v


def test_freeze_fails_closed_on_a_missing_tag():
    import subprocess, tempfile
    logs, repo = w2cc.LOGS, w2cc.REPO
    with tempfile.TemporaryDirectory() as tmp:     # a clean repo with no tag; env attestation passes
        git = ["git", "-C", tmp, "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run(git + ["init", "-q"], check=True)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "base"], check=True)
        with open(os.path.join(tmp, "launchd-kalshi-worker.out.log"), "w") as f:
            f.write("[kalshi-worker] starting; scan interval 15000ms; port 4001\n")
        w2cc.LOGS, w2cc.REPO = tmp, tmp
        try:
            r = w2cc.check_freeze("no-such-tag-w2pp")         # git exits 128 with empty stdout
            head = w2cc.check_freeze("HEAD")                   # the control: same repo, tag present
        finally:
            w2cc.LOGS, w2cc.REPO = logs, repo
    assert head["ok"], head
    assert r["env_attestation"].startswith("[kalshi-worker]") and r["calibration_json_absent"], r
    assert not r["git_ok"] and not r["ok"] and r["diff_vs_tag"].startswith("git failed"), r
    assert w2cc.check_freeze("w2prime-instrument-20260806")["git_ok"]


def test_listing_yields_exactly_the_two_thursday_pauses():
    got = [(iso(a), iso(b)) for a, b in w2cc.excluded_intervals(listing(), T0, T1)]
    assert got == [("2026-08-13T06:45:00Z", "2026-08-13T09:00:00Z"),
                   ("2026-08-20T06:45:00Z", "2026-08-20T09:00:00Z")], got


def test_pause_gaps_are_zeroed():
    ex = w2cc.excluded_intervals(listing(), T0, T1)
    r = w2cc.shadow_gaps(rows_except(AUG13, AUG20), T0, T1, ex)
    assert r["ok"] and r["gaps"] == [] and r["max_gap_h"] == 0.0, r
    wall = w2cc.shadow_gaps(rows_except(AUG13, AUG20), T0, T1, [])
    assert not wall["ok"] and wall["max_gap_h"] > 2.2, wall  # the unamended rule voids it


def test_host_outages_still_fail_w2prime():
    ex = w2cc.excluded_intervals(listing(), T0, T1)
    r = w2cc.shadow_gaps(rows_except(AUG13, AUG17, AUG19, AUG20), T0, T1, ex)
    assert not r["ok"], r
    assert r["gaps"] == [(AUG17[0], AUG17[1]), (AUG19[0], AUG19[1])], r["gaps"]
    assert abs(r["max_gap_h"] - (ms(AUG17[1]) - ms(AUG17[0])) / 3_600_000) < 1e-9


def test_faults_either_side_of_a_pause_join_into_one_gap():
    # 59 min lost before and after the Aug 20 pause: masking would pass two
    # sub-hour gaps; compression must see one 1.97 h gap and fail.
    ex = w2cc.excluded_intervals(listing(), T0, T1)
    fault = ("2026-08-20T05:46:00Z", "2026-08-20T09:59:00Z")
    r = w2cc.shadow_gaps(rows_except(AUG13, fault), T0, T1, ex)
    assert not r["ok"] and 1.9 < r["max_gap_h"] < 2.0, r


def test_collector_pause_costs_two_hour_files_and_runs_join_across_it():
    ex = w2cc.excluded_intervals(listing(), T0, T1)
    pause = ("2026-08-13T07", "2026-08-13T08", "2026-08-20T07", "2026-08-20T08")
    r = w2cc.collector_hours(hours_except(*pause), T0, T1, ex)
    assert r["ok"] and r["worst_coverage"] == 1.0 and r["worst_gap_h"] == 0, r
    r = w2cc.collector_hours(hours_except(*pause, "2026-08-20T06", "2026-08-20T09"), T0, T1, ex)
    assert not r["ok"] and r["worst_gap_h"] == 2, r


def test_published_window_follows_dst():
    got = [(iso(a), iso(b)) for a, b in
           w2cc.published_pauses(ms("2026-10-29T00:00:00Z"), ms("2026-11-06T00:00:00Z"))]
    assert got == [("2026-10-29T06:45:00Z", "2026-10-29T09:15:00Z"),   # EDT
                   ("2026-11-05T07:45:00Z", "2026-11-05T10:15:00Z")], got  # EST


def closes(start, stop, skip=()):
    t, out = ms(start), []
    while t <= ms(stop):
        if not any(ms(a) < t < ms(b) for a, b in skip):
            out.append({"close_time": iso(t)})
        t += w2cc.MARKET_MS
    return out


def test_only_the_overlap_with_the_padded_pause_is_excluded():
    t0, t1 = ms("2026-08-17T00:00:00Z"), ms("2026-08-21T00:00:00Z")
    tuesday = ("2026-08-18T06:45:00Z", "2026-08-18T09:15:00Z")      # not a Thursday
    early = ("2026-08-20T06:00:00Z", "2026-08-20T09:15:00Z")        # no market from 06:00
    lst = closes("2026-08-17T00:15:00Z", "2026-08-21T00:00:00Z", skip=(tuesday, early))
    got = [(iso(a), iso(b)) for a, b in w2cc.excluded_intervals(lst, t0, t1)]
    assert got == [("2026-08-20T06:45:00Z", "2026-08-20T09:00:00Z")], got  # 06:00–06:45 stays


def test_exchange_overrun_costs_only_its_excess():
    # Maintenance overruns: the next market opens 09:30, not 09:00.
    t0, t1 = ms("2026-08-19T10:00:00Z"), ms("2026-08-21T10:00:00Z")
    lst = closes("2026-08-19T10:15:00Z", "2026-08-21T10:00:00Z",
                 skip=(("2026-08-20T06:45:00Z", "2026-08-20T09:45:00Z"),))
    ex = w2cc.excluded_intervals(lst, t0, t1)
    assert [(iso(a), iso(b)) for a, b in ex] == [("2026-08-20T06:45:00Z", "2026-08-20T09:15:00Z")]
    def rows(gap):
        a, b = ms(gap[0]), ms(gap[1])
        return [t for t in range(int(t0), int(t1) + 1, 15_000) if not a < t < b] + [a, b]
    r = w2cc.shadow_gaps(rows(("2026-08-20T06:45:10Z", "2026-08-20T09:30:10Z")), t0, t1, ex)
    assert r["ok"] and abs(r["max_gap_h"] - 0.25) < 0.01, r          # 15 min excess only
    r = w2cc.shadow_gaps(rows(("2026-08-20T06:45:10Z", "2026-08-20T10:20:10Z")), t0, t1, ex)
    assert not r["ok"], r                                            # a later host fault still fails


def fake_proc(tmp, workers):
    for pid, (cmd, env) in workers.items():
        d = os.path.join(tmp, str(pid))
        os.makedirs(d)
        with open(os.path.join(d, "cmdline"), "wb") as f:
            f.write(cmd)
        with open(os.path.join(d, "environ"), "wb") as f:
            f.write(b"\0".join(f"{k}={v}".encode() for k, v in env.items()) + b"\0")
    return tmp


def test_worker_env_check_fails_closed():
    import tempfile
    worker = b"node\0node_modules/.bin/tsx\0src/kalshi/worker.ts\0"
    gates = {g: "0" for g in w2cc.ORDER_GATES}
    vector = {"SPOT_FEED_REST": "https://example.invalid/spot"}
    good = {**gates, **vector, "PATH": "/usr/bin"}
    with tempfile.TemporaryDirectory() as tmp:
        proc = fake_proc(tmp, {41: (worker, good), 42: (b"python3\0other.py\0", {})})
        envs = w2cc.worker_environs(proc)
        assert sorted(envs) == [41]
        assert w2cc.check_worker_env(envs, vector)["ok"]
        assert not w2cc.check_worker_env(envs, None)["ok"]            # no lock vector
        assert not w2cc.check_worker_env({}, vector)["ok"]            # nothing readable
        assert not w2cc.check_worker_env(envs, {})["ok"]              # endpoint drift
        for bad in ({**good, "KALSHI_SCAN_INTERVAL_MS": "15000"},     # a knob, even at default
                    {**good, "KALSHI_ALLOW_ORDERS": "1"},             # an armed gate
                    {k: v for k, v in good.items() if k != "KALSHI_DUST_ENABLED"}):
            assert not w2cc.check_worker_env({41: bad}, vector)["ok"], bad


def test_verdict_fails_closed():
    passing = "gates: G1(PASS) G2(PASS) G3(PASS) G6(PASS) G7(PASS)   [G2 bound z≥1.7]\n"
    tripped = "fire-coverage: 200/210 exchange-settled  ⚠ TRIPWIRE — window suspect (§4)\n"
    assert w2cc.verdict(0, passing, False)[1] == 0 and "GO —" in w2cc.verdict(0, passing, False)[0]
    line, code = w2cc.verdict(0, tripped + passing, False)       # prereg §8: suspect window
    assert code == 1 and "NO-GO (data)" in line, line
    line, code = w2cc.verdict(1, passing, False)                  # scorer crashed
    assert code == 1 and "NO-GO (integrity)" in line, line
    line, code = w2cc.verdict(0, "window: …\n", False)            # no gate line printed
    assert code == 1 and "NO-GO (integrity)" in line, line
    assert "mechanism" in w2cc.verdict(0, passing.replace("G7(PASS)", "G7(FAIL)"), False)[0]
    assert w2cc.verdict(0, "CONTINUE\n", True) == ("CONTINUE", 0)
    assert w2cc.verdict(2, "", True) == ("NO-GO (integrity)", 1)
    assert w2cc.verdict(0, "", True) == ("NO-GO (integrity)", 1)


def edge_run(since, until):
    """A perfect host over a 14-day window, closed live 5 min after its end: the
    listing starts 3 h early but holds no market that closes after the close runs."""
    pause = ("2026-10-08T06:45:00Z", "2026-10-08T09:15:00Z")         # no closes strictly inside
    pause0 = ("2026-09-24T06:45:00Z", "2026-09-24T09:15:00Z")
    t0, t1 = ms(since), ms(until)
    live = closes(iso(t0 - w2cc.LISTING_PAD_MS), iso(t1 + 300_000), skip=(pause0, pause))
    quiet = [(ms("2026-09-24T07:00:00Z"), ms("2026-09-24T09:00:00Z")),
             (ms("2026-10-08T07:00:00Z"), ms("2026-10-08T09:00:00Z"))]   # no market, no row
    rows = [t for t in range(int(t0), int(t1) + 1, 15_000) if not any(a <= t < b for a, b in quiet)]
    return w2cc.shadow_gaps(rows, t0, t1, w2cc.excluded_intervals(live, t0, t1))


def test_live_close_fails_a_window_ending_late_in_the_pause():
    # The pad anchors the start edge only: at a live close, no market after the
    # end has settled. So a 14-day window may not start (and end) on a Thursday
    # at 04:00 or 05:00 ET (08:00Z or 09:00Z in EDT). 03:00 ET and 06:00 ET pass.
    # 04:00 ET leaves a gap of 1 h plus one scan interval, past the 1 h rule.
    for hh, ok in (("07", True), ("08", False), ("09", False), ("10", True)):
        r = edge_run(f"2026-09-24T{hh}:00:00Z", f"2026-10-08T{hh}:00:00Z")
        assert r["ok"] is ok, (hh, r)
    r = edge_run("2026-09-24T08:00:00Z", "2026-10-07T08:00:00Z")    # start in the pause, end Wednesday
    assert r["ok"] and r["max_gap_h"] < 0.02, r


def test_api_base_is_part_of_the_env_vector():
    gates = {g: "0" for g in w2cc.ORDER_GATES}
    base = w2cc.API_BASE_DEFAULT
    env = {41: {**gates, "KALSHI_API_BASE": base}}
    vector = {"KALSHI_API_BASE": base}
    assert w2cc.check_worker_env(env, vector, base)["ok"]
    assert not w2cc.check_worker_env(env, {}, base)["ok"]                          # worker drifted
    assert not w2cc.check_worker_env(env, vector, "https://demo-api.kalshi.co")["ok"]  # wrapper drifted


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"{len(tests)} checks passed")
