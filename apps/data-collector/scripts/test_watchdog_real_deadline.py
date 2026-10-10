"""Real-time Pi acceptance at the production 300s / 30s settings."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from test_supervisor_watchdog import build_app


def test_missing_deltas_relaunch_within_330_seconds_at_production_settings(tmp_path):
    app = build_app(tmp_path, 'sleep 600')
    log_dir = tmp_path / 'logs'; log_dir.mkdir()
    # A large, non-writable legacy log cannot interfere with the health loop.
    err = app / 'ops/state/launchd-collector.err.log'; err.write_bytes(b'x' * 2_000_000); err.chmod(0o400)
    env = {**os.environ, 'DATA_COLLECTOR_LOG_DIR': str(log_dir), 'COLLECTOR_STALE_SECONDS': '300',
           'COLLECTOR_WATCH_INTERVAL': '30', 'COLLECTOR_GRACE_SECONDS': '5'}
    proc = subprocess.Popen(['bash', str(app / 'scripts/run-collector-supervised.sh')], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    path = app / 'ops/state/collector-supervisor.jsonl'; events = []
    deadline = time.monotonic() + 335
    try:
        while time.monotonic() < deadline:
            if path.exists(): events = [json.loads(line) for line in path.read_text().splitlines()]
            if len([e for e in events if e['event'] == 'start']) >= 2: break
            time.sleep(1)
    finally:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM); proc.wait(timeout=15)
    starts = [e for e in events if e['event'] == 'start']
    assert len(starts) >= 2, events
    from datetime import datetime
    elapsed = (datetime.fromisoformat(starts[1]['ts']) - datetime.fromisoformat(starts[0]['ts'])).total_seconds()
    assert 300 <= elapsed <= 330, elapsed
    assert any(e['event'] == 'stale_restart' for e in events)
    (tmp_path / 'deadline-result.json').write_text(json.dumps({'elapsed_seconds': elapsed, 'events': events}, indent=2))
