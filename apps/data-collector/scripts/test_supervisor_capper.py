"""Tests for run-collector-supervised.sh's error-log cap.

Written 2026-10-06 after the cap failed silently for ~2 months, reached 8.7GB,
filled the Pi's root filesystem and ended the W2'' validation window.

Both defects it had are asserted here, because each was invisible to every check
that existed at the time:

  1. The log was root-owned 0644 while the supervisor ran unprivileged, so the
     cat-copy-back got EACCES on every 30s tick, left an orphaned .captmp behind,
     and never capped anything. Nothing reported it.
  2. The staging temp was written next to the log -- into the very filesystem the
     cap exists to relieve -- so on a full disk the cap was guaranteed to fail at
     exactly the moment it mattered.

Run: pytest apps/data-collector/scripts/test_supervisor_capper.py
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "run-collector-supervised.sh"
OVER_CAP = 1048576 + 1  # the cap fires above 1 MiB


def run_capper(tmp_path: Path, *, calls: int = 1, cap_tmpdir: Path | None = None) -> dict:
    """Source the supervisor in lib-only mode and call cap_err_log `calls` times."""
    state = tmp_path / "ops" / "state"
    state.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "COLLECTOR_LIB_ONLY": "1",
        "DATA_COLLECTOR_LOG_DIR": str(tmp_path / "logs"),
    }
    if cap_tmpdir is not None:
        env["COLLECTOR_CAP_TMPDIR"] = str(cap_tmpdir)
    # STATE_DIR is derived from the script's own location, so run a copy whose
    # parent layout we control.
    app = tmp_path / "app"
    (app / "scripts").mkdir(parents=True, exist_ok=True)
    (app / "ops" / "state").mkdir(parents=True, exist_ok=True)
    local = app / "scripts" / SCRIPT.name
    local.write_bytes(SCRIPT.read_bytes())
    local.chmod(0o755)

    body = "\n".join(f'cap_err_log; echo "rc{i}=$?"' for i in range(calls))
    proc = subprocess.run(
        ["/bin/bash", "-c", f'source "{local}"\n{body}\n'],
        capture_output=True, text=True, env=env,
    )
    ledger = app / "ops" / "state" / "collector-supervisor.jsonl"
    events = []
    if ledger.exists():
        for line in ledger.read_text().splitlines():
            if line.strip():
                events.append(json.loads(line))
    return {
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
        "events": events,
        "err_log": app / "ops" / "state" / "launchd-collector.err.log",
        "app": app,
    }


def write_oversized(err_log: Path) -> None:
    err_log.parent.mkdir(parents=True, exist_ok=True)
    line = "[data-collector] orderbook-deltas gzip backpressure\n"
    err_log.write_text(line * (OVER_CAP // len(line) + 1))
    assert err_log.stat().st_size > OVER_CAP


def test_oversized_writable_log_is_capped_and_inode_preserved(tmp_path):
    """The happy path: cap fires, file shrinks, and the inode survives.

    Inode preservation is load-bearing -- launchd/systemd hold the fd open, so a
    tail|mv would orphan it and the file would keep growing invisibly.
    """
    res = run_capper(tmp_path, calls=0)
    err_log = res["err_log"]
    write_oversized(err_log)
    before_inode = err_log.stat().st_ino

    res = run_capper(tmp_path, calls=1)
    assert "rc0=0" in res["stdout"], res["stdout"]
    assert err_log.stat().st_size < OVER_CAP
    assert err_log.stat().st_ino == before_inode, "cap must truncate in place"


def test_unwritable_log_is_reported_once_not_retried_in_silence(tmp_path):
    """THE REGRESSION TEST. An unwritable log must announce itself, exactly once.

    This is the bug that cost the window: EACCES every tick for two months with
    no event emitted anywhere.
    """
    res = run_capper(tmp_path, calls=0)
    err_log = res["err_log"]
    write_oversized(err_log)
    err_log.chmod(0o444)  # unwritable by the running (non-root) user

    res = run_capper(tmp_path, calls=3)
    blocked = [e for e in res["events"] if e["event"] == "errlog_cap_blocked"]
    assert len(blocked) == 1, f"expected exactly one announcement, got {len(blocked)}"
    assert "not writable" in blocked[0]["reason"]
    # and it must report failure to its caller rather than pretending success
    assert "rc0=1" in res["stdout"], res["stdout"]


def test_unwritable_log_leaves_no_orphaned_temp(tmp_path):
    """The orphaned .captmp was the only on-disk trace the cap was broken."""
    res = run_capper(tmp_path, calls=0)
    err_log = res["err_log"]
    write_oversized(err_log)
    (err_log.parent / "launchd-collector.err.log.captmp").write_text("stale orphan\n")
    err_log.chmod(0o444)

    run_capper(tmp_path, calls=2)
    assert not (err_log.parent / "launchd-collector.err.log.captmp").exists(), \
        "a blocked cap must clear the orphan, not accumulate one per tick"


def test_cap_succeeds_when_the_logs_own_directory_cannot_take_new_files(tmp_path):
    """Defect 2, tested by mechanism rather than by end state.

    Staging the temp next to the log means a full target filesystem breaks the cap
    at exactly the moment it is needed. A full disk is awkward to simulate, but the
    *same* distinguishing condition is: the directory refuses new files while the
    existing log stays writable. Removing write permission on a directory blocks
    file creation yet still permits writing an already-open/owned file.

    Pre-fix, `tail > "$ERR_LOG.captmp"` cannot create its temp here and the cap
    fails. Post-fix the temp lives on tmpfs and the cap succeeds. An end-state
    assertion would miss this, since the old code deleted its temp on the happy
    path -- which is why this test replaced one.
    """
    res = run_capper(tmp_path, calls=0)
    err_log = res["err_log"]
    write_oversized(err_log)
    ledger = err_log.parent / "collector-supervisor.jsonl"
    ledger.touch()  # appends must still work; only *creation* is blocked

    staging = tmp_path / "staging"
    staging.mkdir()
    original_mode = err_log.parent.stat().st_mode
    err_log.parent.chmod(0o555)
    try:
        res = run_capper(tmp_path, calls=1, cap_tmpdir=staging)
        assert "rc0=0" in res["stdout"], (
            "cap must not depend on creating a file in the directory it is "
            f"relieving; stdout={res['stdout']!r} stderr={res['stderr']!r}"
        )
        assert err_log.stat().st_size < OVER_CAP
    finally:
        err_log.parent.chmod(original_mode)

    assert list(err_log.parent.glob("*captmp*")) == []
    assert list(staging.glob("*")) == [], "staged temp must be cleaned up"


def test_undersized_log_is_left_alone(tmp_path):
    res = run_capper(tmp_path, calls=0)
    err_log = res["err_log"]
    err_log.parent.mkdir(parents=True, exist_ok=True)
    err_log.write_text("small\n")

    res = run_capper(tmp_path, calls=1)
    assert err_log.read_text() == "small\n"
    assert [e for e in res["events"] if e["event"] == "errlog_cap_blocked"] == []


def test_size_probe_reaches_the_gnu_fallback(tmp_path):
    """`stat -f%z` must exit non-zero on GNU so `-c%s` is reached.

    This is the inverse of the newest_delta_mtime bug: there, `stat -f %m` (with a
    space) exits 0 with filesystem text, so its `||` fallback never runs. Pinning
    the distinction keeps someone from "harmonising" the two call sites.
    """
    probe = subprocess.run(
        ["/bin/bash", "-c",
         f'v="$(stat -f%z "{SCRIPT}" 2>/dev/null || stat -c%s "{SCRIPT}" 2>/dev/null || echo 0)"; '
         'echo "$v"'],
        capture_output=True, text=True,
    )
    value = probe.stdout.strip()
    assert value.isdigit(), f"size probe must yield a bare integer, got: {value!r}"
    assert int(value) == SCRIPT.stat().st_size


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
