"""Tests for the collector's fail-loud-on-ENOSPC exit path.

Written 2026-10-06. This is the defect that cost the W2'' validation window, and
it is one defect in four parts rather than four defects:

    rotate() attached no 'error' handler to either stream, so a disk-full write
    became an unhandled 'error' event -> throw -> uncaughtException -> shutdown()
    -> process.exit(0).

A crash therefore reported SUCCESS. The collector's own lifecycle archive dates
it exactly:

    {"recv_ts_ms":1791012040484,"event":"uncaught_exception",
     "error":"Error: ENOSPC: no space left on device, write"}
        = 2026-10-03T07:20:40.484Z

and 34 of the 36 child exits that followed read rc=0, which is why systemd's
NRestarts stayed at 0 and nothing anywhere reported a problem for three days.

The cure is an exit code that cannot be mistaken for success, carried end to end:

    ENOSPC -> persistence.ts exits EXIT_DISK_FULL
           -> run-collector-supervised.sh stops retrying and exits the same code
           -> RestartPreventExitStatus= holds the unit in `failed`
           -> OnFailure= fires and the journal records status=74

The last link matters most. Only 3 uncaught_exception records survive against 35
child exits, because logLifecycle() writes through the same rotator onto the same
full filesystem -- the logger shared a failure domain with the thing it was
logging. The exit code in the journal is the record that survives when the
collector's own log cannot be written.

Run: pytest apps/data-collector/scripts/test_collector_fail_loud.py
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent
APP = SCRIPTS.parent
SCRIPT = SCRIPTS / "run-collector-supervised.sh"
PERSISTENCE = APP / "src" / "persistence.ts"
INDEX = APP / "src" / "index.ts"
UNIT = SCRIPTS / "systemd" / "kalshi-collector.service"

EXPECTED_CODE = 74  # sysexits EX_IOERR; see the comment in persistence.ts


def node_harness(body: str, **env_extra: str) -> subprocess.CompletedProcess:
    """Run a one-off ES module against the real persistence.ts.

    Node >= 23 strips TypeScript types natively, so the module under test is
    imported directly with no build step, no tsx and no bundler.
    """
    src = f'import {{ MultiChannelRotator, fatalWriteError, exitCodeForError, EXIT_DISK_FULL }} from "{PERSISTENCE}";\n{body}\n'
    res = subprocess.run(
        ["node", "--input-type=module", "-e", src],
        capture_output=True, text=True, env={**os.environ, **env_extra}, timeout=60,
    )
    # A missing export is a link-time SyntaxError and Node exits 1 -- which is
    # exactly the code one of these tests asserts, so without this guard that
    # test passes against pre-fix code for the wrong reason. Caught in review of
    # this very file, which is the second time an exit code has been read as
    # evidence of something it did not mean.
    assert "does not provide an export" not in res.stderr, (
        f"persistence.ts is missing an export the harness needs: {res.stderr!r}"
    )
    assert "SyntaxError" not in res.stderr, f"persistence.ts did not load: {res.stderr!r}"
    return res


# ---------------------------------------------------------------- the constant

def test_the_disk_full_code_is_identical_in_all_three_places():
    """persistence.ts, the supervisor and the unit must agree, or the chain breaks.

    Nothing enforces this at runtime: a mismatch means the collector exits 74,
    the supervisor does not recognise it, systemd restarts anyway, and the cure
    silently reverts to the behaviour that lost the window. The whole mechanism
    is three independent literals, so pin them together.
    """
    ts = re.search(r"export const EXIT_DISK_FULL = (\d+);", PERSISTENCE.read_text())
    sh = re.search(r"^EXIT_DISK_FULL=(\d+)$", SCRIPT.read_text(), re.M)
    unit = re.search(r"^RestartPreventExitStatus=(\d+)$", UNIT.read_text(), re.M)
    assert ts and sh and unit, f"missing declaration: ts={bool(ts)} sh={bool(sh)} unit={bool(unit)}"
    assert int(ts[1]) == int(sh[1]) == int(unit[1]) == EXPECTED_CODE, (
        f"disk-full code disagrees: persistence.ts={ts[1]} supervisor={sh[1]} unit={unit[1]}"
    )


# ------------------------------------------------------------- classification

def test_enospc_exits_with_the_disk_full_code():
    """THE REGRESSION TEST. A disk-full write must not exit 0."""
    res = node_harness(
        'fatalWriteError("orderbook-deltas", Object.assign('
        'new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));\n'
        'console.log("UNREACHABLE");'
    )
    assert res.returncode == EXPECTED_CODE, f"rc={res.returncode} stderr={res.stderr!r}"
    assert "UNREACHABLE" not in res.stdout, "fatalWriteError must not return to its caller"
    assert "FATAL" in res.stderr and "ENOSPC" in res.stderr


def test_an_ordinary_error_exits_one_so_the_supervisor_still_restarts():
    """The disk-full code is reserved. A transient error must stay restartable.

    If every write error returned EXIT_DISK_FULL, RestartPreventExitStatus= would
    turn a one-off EIO into a permanently dead collector -- trading a silent
    failure for a loud one that is just as total.
    """
    assert node_harness("process.exit(exitCodeForError(new Error('boom')));").returncode == 1
    assert node_harness(
        "process.exit(exitCodeForError(Object.assign(new Error('x'), { code: 'EIO' })));"
    ).returncode == 1


# ------------------------------------------------------------------- the wiring

def test_a_real_stream_error_reaches_the_fatal_handler(tmp_path):
    """Classification is worthless unless rotate() actually subscribes to 'error'.

    Asserted with a real stream failure rather than an injected one: a read-only
    log directory makes createWriteStream() emit EACCES on its own. ENOSPC cannot
    be induced portably without root, but the handler it must reach is the same
    one, and the subscription is what this test is about.

    Pre-fix this also exits non-zero -- an unhandled 'error' crashes Node -- so
    the exit code alone does not distinguish the fix. The FATAL line does: it
    exists only if our handler ran.
    """
    logs = tmp_path / "logs"
    logs.mkdir()
    logs.chmod(0o555)
    try:
        res = node_harness(
            f'const r = new MultiChannelRotator("{logs}");\n'
            'r.write("orderbook-deltas", { a: 1 });\n'
            'setTimeout(() => { console.log("NO_ERROR_FIRED"); process.exit(0); }, 5000);'
        )
    finally:
        logs.chmod(0o755)
    assert "NO_ERROR_FIRED" not in res.stdout, "the stream error never surfaced"
    assert "[data-collector] FATAL" in res.stderr, (
        f"rotate() did not route the stream error to fatalWriteError; stderr={res.stderr!r}"
    )
    assert res.returncode != 0


def test_the_disk_full_path_does_not_wait_for_a_drain():
    """On a full disk the gzip trailer cannot land either, so draining is delay.

    closeAsync() allows 3s per channel. Spending it per restart bought nothing on
    2026-10-03 and overlapped the exit with the supervisor's next start.
    """
    started = time.monotonic()
    res = node_harness(
        'fatalWriteError("orderbook-deltas", Object.assign('
        'new Error("ENOSPC"), { code: "ENOSPC" }));'
    )
    assert res.returncode == EXPECTED_CODE
    assert time.monotonic() - started < 3.0, "the disk-full exit stalled as if draining"


# ------------------------------------------------------------- the supervisor

def build_app(tmp_path: Path, child_body: str) -> Path:
    """Scratch APP_DIR with a fake `tsx`, which is what RUN resolves to."""
    app = tmp_path / "app"
    (app / "scripts" / "systemd").mkdir(parents=True, exist_ok=True)
    (app / "ops" / "state").mkdir(parents=True, exist_ok=True)
    (app / "node_modules" / ".bin").mkdir(parents=True, exist_ok=True)
    local = app / "scripts" / SCRIPT.name
    local.write_bytes(SCRIPT.read_bytes())
    local.chmod(0o755)
    tsx = app / "node_modules" / ".bin" / "tsx"
    tsx.write_text("#!/bin/bash\n" + child_body + "\n")
    tsx.chmod(0o755)
    return app


def run_until_exit(app: Path, log_dir: Path, *, timeout: float) -> tuple[int | None, list[dict]]:
    """Let the supervisor exit on its own and return its code plus the ledger.

    The watchdog tests SIGTERM the supervisor; here its own exit IS the result,
    so it is never signalled unless it overruns.
    """
    env = {
        **os.environ,
        "DATA_COLLECTOR_LOG_DIR": str(log_dir),
        "COLLECTOR_STALE_SECONDS": "60",
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
    rc: int | None
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        rc = None
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
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
    return rc, events


def test_supervisor_stops_and_propagates_the_disk_full_code(tmp_path):
    """THE REGRESSION TEST for the retry loop.

    Restarting into a full disk is what turned one ENOSPC into 35 restarts across
    three days. The supervisor must stop AND exit the same code, because the code
    is what RestartPreventExitStatus= matches on and what the journal records --
    stopping quietly would leave the same silence behind.
    """
    app = build_app(tmp_path, f"exit {EXPECTED_CODE}")
    rc, events = run_until_exit(app, tmp_path / "logs", timeout=25)

    assert rc == EXPECTED_CODE, f"supervisor exited {rc}, must propagate {EXPECTED_CODE}"
    starts = [e for e in events if e["event"] == "start"]
    assert len(starts) == 1, f"must not relaunch into a full disk; {len(starts)} starts"
    assert [e for e in events if e["event"] == "disk_full"], "the stop must be announced"
    assert not [e for e in events if e["event"] == "backoff"], "backoff means it meant to retry"


def test_supervisor_still_restarts_on_an_ordinary_nonzero_exit(tmp_path):
    """The contrast case, which is what makes the test above about ENOSPC.

    A supervisor that stopped on ANY non-zero exit would pass the previous test
    while being a much worse bug: one transient crash and collection is over for
    the rest of the window.
    """
    app = build_app(tmp_path, "exit 1")
    rc, events = run_until_exit(app, tmp_path / "logs", timeout=12)

    assert rc is None, f"supervisor exited {rc} on rc=1; it must keep supervising"
    assert len([e for e in events if e["event"] == "start"]) >= 2, (
        f"expected repeated restarts, got {[e['event'] for e in events]}"
    )
    assert not [e for e in events if e["event"] == "disk_full"]


# ------------------------------------------------------- index.ts exit policy

def test_index_has_no_exit_zero_on_a_failure_path():
    """Structural, deliberately, and worth saying why.

    The behavioural version would have to run index.ts, which opens a live Kalshi
    websocket on module load -- a network call to the exchange, from a test, with
    a real credential. Not worth it for a one-line wiring assertion, so this pins
    the shape instead and the honest limitation is that it checks source, not
    behaviour. The classification it delegates to IS covered behaviourally above.
    """
    src = INDEX.read_text()
    assert "process.exit(0)" not in src, (
        "process.exit(0) on the shutdown path is the defect: it made an ENOSPC "
        "crash indistinguishable from a clean SIGTERM"
    )
    assert re.search(r"async function shutdown\(reason: string, code = 0\)", src), (
        "shutdown() must take the exit code rather than hardcoding it"
    )
    assert re.search(r'shutdown\("uncaughtException", code\)', src), (
        "the uncaughtException path must pass a non-zero code"
    )
    assert "exitCodeForError" in src, "classification must be shared with persistence.ts"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
