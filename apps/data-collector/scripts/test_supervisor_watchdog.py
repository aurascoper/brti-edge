"""Tests for run-collector-supervised.sh's stall watchdog.

Written 2026-10-06 after discovering the watchdog had NEVER fired on the Linux
scoring host: zero stale_restart events across 48 supervisor starts, including a
20-hour stretch on 2026-10-03 where the child was alive and wrote nothing. That
gap ended the W2'' validation window.

The cause was a portability trap worth stating plainly, since a `||` fallback
looks like it handles it and does not:

    m="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)"

On GNU coreutils `stat -f` means --file-system, so `%m` is parsed as a FILENAME.
stat errors on `%m` (swallowed), SUCCEEDS for the real file, prints a six-line
filesystem block to stdout, and exits 0. Exit 0 means the `||` branch never runs,
so `m` held filesystem text, the integer comparison failed, and the function
returned 0 -- which the caller read as "no files yet" and skipped the check.

A `||` fallback only guards against non-zero exit. "Wrong answer, exit 0" defeats
it. test_probe_rejects_a_stat_that_succeeds_with_non_numeric_output pins that.

Run: pytest apps/data-collector/scripts/test_supervisor_watchdog.py
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "run-collector-supervised.sh"


def build_app(tmp_path: Path, child_body: str) -> Path:
    """Lay out a scratch APP_DIR with a fake `tsx`, which is what RUN resolves to.

    No production seam is needed for this: the script picks
    "$APP_DIR/node_modules/.bin/tsx" when it is executable, so planting one there
    gives a fully controllable child.
    """
    app = tmp_path / "app"
    (app / "scripts").mkdir(parents=True, exist_ok=True)
    (app / "ops" / "state").mkdir(parents=True, exist_ok=True)
    (app / "node_modules" / ".bin").mkdir(parents=True, exist_ok=True)

    local = app / "scripts" / SCRIPT.name
    local.write_bytes(SCRIPT.read_bytes())
    local.chmod(0o755)

    tsx = app / "node_modules" / ".bin" / "tsx"
    tsx.write_text("#!/bin/bash\n" + child_body + "\n")
    tsx.chmod(0o755)
    return app


def run_supervisor(app: Path, log_dir: Path, *, seconds: float, stale: int = 2) -> list[dict]:
    env = {
        **os.environ,
        "DATA_COLLECTOR_LOG_DIR": str(log_dir),
        "COLLECTOR_STALE_SECONDS": str(stale),
        "COLLECTOR_WATCH_INTERVAL": "1",
        "COLLECTOR_MIN_UP_SECONDS": "1",
        "COLLECTOR_GRACE_SECONDS": "1",
        "COLLECTOR_MAX_BACKOFF": "1",
    }
    proc = subprocess.Popen(
        ["/bin/bash", str(app / "scripts" / SCRIPT.name)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=env, start_new_session=True,
    )
    try:
        time.sleep(seconds)
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait(timeout=5)

    ledger = app / "ops" / "state" / "collector-supervisor.jsonl"
    events = []
    if ledger.exists():
        for line in ledger.read_text().splitlines():
            if line.strip():
                events.append(json.loads(line))
    return events


def test_a_live_child_writing_nothing_is_restarted(tmp_path):
    """THE REGRESSION TEST: this is 2026-10-03 in miniature.

    A child that stays up and produces no delta file must be restarted. The old
    code returned 0 from newest_delta_mtime and the caller skipped the check, so
    this ran for 20 hours without a single event.
    """
    app = build_app(tmp_path, "sleep 600")
    log_dir = tmp_path / "logs"
    log_dir.mkdir()

    events = run_supervisor(app, log_dir, seconds=8, stale=2)
    kinds = [e["event"] for e in events]
    assert "stale_restart" in kinds, (
        "a live child writing nothing must trip the watchdog; events seen: " + str(kinds)
    )
    reason = next(e["reason"] for e in events if e["event"] == "stale_restart")
    assert "no orderbook-deltas bytes written" in reason, reason


def test_a_child_that_stops_writing_is_restarted(tmp_path):
    """The classic stall: a file exists but stops advancing."""
    app = build_app(tmp_path, "sleep 600")
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    stale_file = log_dir / "orderbook-deltas-2026-10-06T23.jsonl.gz"
    stale_file.write_bytes(b"x")
    old = time.time() - 3600
    os.utime(stale_file, (old, old))

    events = run_supervisor(app, log_dir, seconds=8, stale=2)
    reasons = [e["reason"] for e in events if e["event"] == "stale_restart"]
    assert reasons, "an hour-old delta file must trip the watchdog"
    assert "no orderbook-deltas write in" in reasons[0], reasons[0]


def test_a_healthy_child_is_left_alone(tmp_path):
    """No false positives: a child that keeps writing must not be restarted."""
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    target = log_dir / "orderbook-deltas-2026-10-06T23.jsonl.gz"
    # `echo`, not `:` -- appending zero bytes does not advance mtime, so a no-op
    # write would look exactly like a stall. That distinction is the whole subject
    # of this file, so the fake child has to actually write.
    app = build_app(tmp_path, f'while true; do echo x >> "{target}"; sleep 0.5; done')

    events = run_supervisor(app, log_dir, seconds=8, stale=3)
    kinds = [e["event"] for e in events]
    assert "stale_restart" not in kinds, f"healthy child was restarted; events: {kinds}"
    assert "child_exit" not in kinds, f"healthy child should not exit; events: {kinds}"


def test_probe_rejects_a_stat_that_succeeds_with_non_numeric_output(tmp_path):
    """The GNU trap, reproduced portably by shadowing `stat` on PATH.

    The fake mimics GNU's behaviour exactly: `stat -f ...` prints a filesystem
    block and exits 0, while `stat -c %Y` returns a real epoch. A correct probe
    must reject the first and select the second. The pre-fix code accepted the
    first because it only ever checked the exit status.
    """
    fakedir = tmp_path / "fakebin"
    fakedir.mkdir()
    fake = fakedir / "stat"
    fake.write_text(
        "#!/bin/bash\n"
        'if [ "$1" = "-f" ]; then\n'
        '  echo "  File: \\"x\\""\n'
        '  echo "    ID: 778b58bacffb8220 Namelen: 255     Type: ext2/ext3"\n'
        '  echo "Blocks: Total: 61472675   Free: 6887047    Available: 4375186"\n'
        "  exit 0\n"
        "fi\n"
        'if [ "$1" = "-c" ]; then echo 1791333728; exit 0; fi\n'
        "exit 1\n"
    )
    fake.chmod(0o755)

    app = build_app(tmp_path, "sleep 1")
    local = app / "scripts" / SCRIPT.name
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "orderbook-deltas-2026-10-06T23.jsonl.gz").write_bytes(b"x")

    probe = subprocess.run(
        ["/bin/bash", "-c",
         f'export PATH="{fakedir}:$PATH"; '
         f'export COLLECTOR_LIB_ONLY=1 DATA_COLLECTOR_LOG_DIR="{log_dir}"; '
         f'source "{local}"; echo "CMD=$STAT_MTIME_CMD"; echo "MT=$(newest_delta_mtime)"'],
        capture_output=True, text=True,
    )
    out = probe.stdout
    assert "CMD=stat -c %Y" in out, f"probe must reject the exit-0-but-wrong form; got: {out!r}"
    mt = out.split("MT=")[1].strip().splitlines()[-1].strip()
    assert mt.isdigit() and int(mt) > 0, f"mtime must be a bare positive integer, got {mt!r}"


def test_newest_delta_mtime_always_returns_a_bare_integer(tmp_path):
    """Whatever happens, the caller must never have to parse multi-line text.

    This is the invariant the old code broke: it handed the caller a six-line
    filesystem block, which `[ "$m" -gt ... ]` then silently rejected.

    Sourcing the script emits its own startup log lines on stdout, so the function's
    result is the LAST line -- and the script is copied into a scratch APP_DIR so its
    ledger writes land there rather than in the real ops/state.
    """
    app = build_app(tmp_path, "sleep 1")
    local = app / "scripts" / SCRIPT.name
    log_dir = tmp_path / "logs"
    log_dir.mkdir()

    for case, setup in (
        ("empty", lambda: None),
        ("one file", lambda: (log_dir / "orderbook-deltas-2026-10-06T23.jsonl.gz").write_bytes(b"x")),
    ):
        setup()
        probe = subprocess.run(
            ["/bin/bash", "-c",
             f'export COLLECTOR_LIB_ONLY=1 DATA_COLLECTOR_LOG_DIR="{log_dir}"; '
             f'source "{local}"; newest_delta_mtime'],
            capture_output=True, text=True,
        )
        lines = [ln for ln in probe.stdout.strip().splitlines() if ln.strip()]
        assert lines, f"[{case}] no output at all"
        value = lines[-1].strip()
        assert value.lstrip("-").isdigit(), f"[{case}] not a bare integer: {value!r}"
        if case == "empty":
            assert value == "0", f"[{case}] empty dir must report 0, got {value!r}"
        else:
            assert int(value) > 0, f"[{case}] expected a positive mtime, got {value!r}"


def test_a_fresh_EMPTY_file_each_hour_still_trips_the_watchdog(tmp_path):
    """THE W2'' SHAPE, and the gap in the first cut of this fix.

    2026-10-03 did not look like "no file". It looked like a brand new EMPTY file
    every hour -- 10-03T08 carries six .pN partitions at exactly 0 bytes, one per
    relaunch. Creation stamps a current mtime, so a watchdog that takes the newest
    file unconditionally reads a just-created empty file as health.

    The fake child reproduces exactly that: it keeps creating fresh empty delta
    files and never writes a byte.
    """
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    app = build_app(tmp_path, (
        'i=0\n'
        'while true; do\n'
        f'  : > "{log_dir}/orderbook-deltas-2026-10-06T23.p$i.jsonl.gz"\n'
        '  i=$((i+1)); sleep 1\n'
        'done'
    ))

    events = run_supervisor(app, log_dir, seconds=9, stale=2)
    kinds = [e["event"] for e in events]
    assert "stale_restart" in kinds, (
        "a child creating fresh EMPTY delta files must still trip the watchdog; "
        f"events: {kinds}"
    )
    # and it must be empties that triggered it, not absence
    created = list(log_dir.glob("orderbook-deltas-*.jsonl.gz"))
    assert created, "the fake child should have created files"
    assert all(f.stat().st_size == 0 for f in created), "all created files should be empty"


def test_the_restart_cadence_is_recorded_not_merely_a_single_fire(tmp_path):
    """Assert the cadence lands in the ledger, rather than reasoning about it.

    A watchdog that fires once and then wedges looks the same as a working one if
    the test only checks for a single event. With stale=2s and a 1s backoff, a
    ~14s run should complete at least two full detect/restart cycles.
    """
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    app = build_app(tmp_path, "sleep 600")

    events = run_supervisor(app, log_dir, seconds=14, stale=2)
    stale = [e for e in events if e["event"] == "stale_restart"]
    starts = [e for e in events if e["event"] == "start"]
    assert len(stale) >= 2, (
        f"expected a repeating cadence, got {len(stale)} stale_restart event(s): "
        f"{[e['reason'] for e in stale]}"
    )
    assert len(starts) >= len(stale), (
        f"every stale_restart must be followed by a restart; starts={len(starts)} stale={len(stale)}"
    )
    # restarts must be monotonically counted, not reset
    counters = [e["restarts"] for e in events if e["event"] == "child_exit"]
    assert counters == sorted(counters), f"restart counter went backwards: {counters}"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
