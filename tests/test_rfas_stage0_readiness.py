"""Regression tests for RFAS Stage 0 review-only unit renderer and storage guard."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
STAGE0_DIR = REPO_ROOT / "ops" / "rfas_stage0"
RENDER_SCRIPT = STAGE0_DIR / "render_units.py"
STORAGE_GUARD = STAGE0_DIR / "storage_guard.sh"
COLLECT_READINESS = STAGE0_DIR / "collect_readiness.sh"


def _write_fake_bin(bin_dir: Path, *, source: str = "/dev/nvme0n1p2", ancestry: str = "Samsung_SSD disk") -> None:
    """Create deterministic command shims in a temp bin directory."""
    bin_dir.mkdir(parents=True, exist_ok=True)

    scripts = {
        "hostname": "#!/usr/bin/env bash\necho ok-computer\n",
        "mountpoint": "#!/usr/bin/env bash\nexit 0\n",
        "findmnt": (
            "#!/usr/bin/env bash\n"
            "args=\"$*\"\n"
            "if [[ $args == *\"-o UUID\"* ]]; then echo '11111111-2222-3333-4444-555555555555'; "
            f"elif [[ $args == *\"-o SOURCE\"* ]]; then echo '{source}'; "
            "elif [[ $args == *\"-o TARGET\"* ]]; then echo \"$RFAS_TEST_MOUNT\"; fi\n"
        ),
        "lsblk": (
            "#!/usr/bin/env bash\n"
            "if [[ $* == *\"MODEL,MOUNTPOINT\"* ]]; then\n"
            f"  echo 'nvme0n1p2 {ancestry} /'\n"
            "else\n"
            f"  echo '{ancestry}'\n"
            "fi\n"
        ),
        "realpath": "#!/usr/bin/env python3\nimport os, sys\nprint(os.path.realpath(sys.argv[-1]))\n",
        "stat": (
            "#!/usr/bin/env python3\n"
            "import os, stat, sys\n"
            "args = sys.argv[1:]\n"
            "fmt = args[1] if len(args) >= 3 and args[0] == '-c' else '%u:%a'\n"
            "target = args[-1]\n"
            "if os.path.basename(target) == 'collector-cutover-approved':\n"
            "    st = os.lstat(target)\n"
            "    mode = stat.S_IMODE(st.st_mode)\n"
            "    print(f'0:{oct(mode)[2:]}' if fmt == '%u:%a' else '0')\n"
            "else:\n"
            "    st = os.lstat(target)\n"
            "    if fmt == '%u':\n"
            "        print(st.st_uid)\n"
            "    else:\n"
            "        print(f'{st.st_uid}:{oct(stat.S_IMODE(st.st_mode))[2:]}')\n"
        ),
        "df": "#!/usr/bin/env bash\necho 'Avail'\necho '107374182400'\n",
        "timedatectl": "#!/usr/bin/env bash\necho 'yes'\n",
        "node": "#!/usr/bin/env bash\necho 'v20.9.0'\n",
        "pnpm": "#!/usr/bin/env bash\nexit 1\n",
    }
    for name, body in scripts.items():
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)


def test_render_units_happy_path_and_fail_closed_validation(tmp_path: Path) -> None:
    out_dir = tmp_path / "units"
    proc = subprocess.run(
        [
            sys.executable,
            str(RENDER_SCRIPT),
            "--user",
            "brti",
            "--repo",
            "/srv/rfas/brti-edge",
            "--mount",
            "/srv/rfas",
            "--uuid",
            "11111111-2222-3333-4444-555555555555",
            "--env-file",
            "/etc/brti-edge/collector.env",
            "--guard",
            "/srv/rfas/brti-edge/ops/rfas_stage0/storage_guard.sh",
            "--min-free-gib",
            "20",
            "--output",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    rendered = sorted(p.name for p in out_dir.iterdir())
    assert rendered == [
        "kalshi-collector.service",
        "kalshi-worker.service",
        "pm-collector.service",
    ]
    for unit_file in out_dir.iterdir():
        body = unit_file.read_text()
        assert "\n[Install]" not in body
        assert "ConditionPathExists=/etc/brti-edge/collector-cutover-approved" in body
        assert "Environment=KALSHI_ALLOW_ORDERS=0 KALSHI_AUTO_SUBMIT=0 KALSHI_DUST_ENABLED=0" in body
        assert "UMask=0077" in body

    bad_cases = [
        ["--user", "root"],
        ["--mount", "/"],
        ["--uuid", "UNVERIFIED"],
        ["--repo", "/srv/rfas/../evil"],
        ["--repo", "/srv/rfas"],
        ["--min-free-gib", "0"],
    ]
    for idx, override in enumerate(bad_cases):
        bad_args = [
            sys.executable,
            str(RENDER_SCRIPT),
            "--user",
            "brti",
            "--repo",
            "/srv/rfas/brti-edge",
            "--mount",
            "/srv/rfas",
            "--uuid",
            "11111111-2222-3333-4444-555555555555",
            "--env-file",
            "/etc/brti-edge/collector.env",
            "--guard",
            "/srv/rfas/brti-edge/ops/rfas_stage0/storage_guard.sh",
            "--min-free-gib",
            "20",
            "--output",
            str(tmp_path / f"bad_{idx}"),
        ]
        flag, val = override
        pos = bad_args.index(flag)
        bad_args[pos + 1] = val
        bad = subprocess.run(bad_args, capture_output=True, text=True, check=False)
        assert bad.returncode != 0


def test_storage_guard_hardening_subvol_logs_and_dotenv(tmp_path: Path) -> None:
    if os.path.exists("/etc/brti-edge/collector-cutover-approved"):
        pytest.skip("Unexpected host cutover marker exists in test environment")

    # Exercise bash script logic against isolated mount/repo layout where host marker absent:
    # Patch a disposable copy ONLY where /etc/brti-edge/collector-cutover-approved is checked
    # so host /etc is never touched and real guard checks run end-to-end.
    marker = tmp_path / "collector-cutover-approved"
    marker.write_text("approved-for-test\n")
    marker.chmod(0o600)

    guard_copy = tmp_path / "storage_guard_test.sh"
    guard_text = STORAGE_GUARD.read_text().replace(
        "/etc/brti-edge/collector-cutover-approved", str(marker)
    )
    guard_copy.write_text(guard_text)
    guard_copy.chmod(0o755)

    mount = tmp_path / "srv_mount"
    repo = mount / "brti-edge"
    app = repo / "apps" / "data-collector"
    log = app / "logs" / "data-collector"
    state = app / "ops" / "state"
    for d in (mount, repo, app, log, state, app / "logs"):
        d.mkdir(parents=True, exist_ok=True)
    # Canonicalize tmp_path in case macOS /var -> /private/var symlink applies.
    mount_real = os.path.realpath(mount)
    repo_real = os.path.realpath(repo)
    app_real = os.path.realpath(app)
    log_real = os.path.realpath(log)

    bin_dir = tmp_path / "bin"
    _write_fake_bin(bin_dir, source="/dev/nvme0n1p2[/@brti]", ancestry="Samsung_SSD_980 disk")

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "RFAS_TEST_MOUNT": mount_real,
            "DATA_COLLECTOR_LOG_DIR": log_real,
            "KALSHI_ALLOW_ORDERS": "0",
            "KALSHI_AUTO_SUBMIT": "0",
            "KALSHI_DUST_ENABLED": "0",
        }
    )
    env.pop("KALSHI_LIVE_TRADING_ENV", None)

    base_cmd = [
        "/usr/bin/env",
        "bash",
        str(guard_copy),
        mount_real,
        "11111111-2222-3333-4444-555555555555",
        repo_real,
        app_real,
        log_real,
        "DATA_COLLECTOR_LOG_DIR",
        "10",
    ]

    # Explicit =0 in .env must be allowed while btrfs [subvol] suffix strips cleanly.
    (repo / ".env").write_text("KALSHI_ALLOW_ORDERS=0\nKALSHI_AUTO_SUBMIT=\"0\"\n")
    ok = subprocess.run(base_cmd, env=env, capture_output=True, text=True, check=False)
    assert ok.returncode == 0, ok.stderr

    # Non-zero order gate in .env must fail closed.
    (repo / ".env").write_text("KALSHI_ALLOW_ORDERS=1\n")
    bad_gate = subprocess.run(base_cmd, env=env, capture_output=True, text=True, check=False)
    assert bad_gate.returncode != 0
    assert "unsafe-dotenv-order-gate" in bad_gate.stderr

    # Routing/grace override in .env must fail closed.
    (repo / ".env").write_text("DATA_COLLECTOR_LOG_DIR=/tmp/evil\n")
    bad_route = subprocess.run(base_cmd, env=env, capture_output=True, text=True, check=False)
    assert bad_route.returncode != 0
    assert "conflicting-dotenv-routing-or-grace" in bad_route.stderr
    (repo / ".env").unlink()

    # Symlinked launchd append log must fail closed.
    evil_log = Path(app_real) / "ops" / "state" / "launchd-collector.out.log"
    target_file = tmp_path / "elsewhere.txt"
    target_file.write_text("hi")
    evil_log.symlink_to(target_file)
    bad_sym = subprocess.run(base_cmd, env=env, capture_output=True, text=True, check=False)
    assert bad_sym.returncode != 0
    assert "unsafe-log-target" in bad_sym.stderr
    evil_log.unlink()

    # Quarantined Toshiba MQ04UBD200 ancestry must fail closed even on matching UUID.
    _write_fake_bin(bin_dir, source="/dev/sda1", ancestry="MQ04UBD200 part\nMQ04UBD200 disk")
    bad_disk = subprocess.run(base_cmd, env=env, capture_output=True, text=True, check=False)
    assert bad_disk.returncode != 0
    assert "quarantined-toshiba" in bad_disk.stderr


def test_collect_readiness_json_non_ready_by_default(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    _write_fake_bin(bin_dir)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{os.environ['PATH']}"
    proc = subprocess.run(
        ["/usr/bin/env", "bash", str(COLLECT_READINESS), "--json"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert data["schema"] == "rfas-stage0-readiness-v1"
    assert data["readiness_verdict"] == "EVIDENCE_ONLY_NOT_CUTOVER_READY"
    assert data["stage0_cutover_approved_marker"] is False
