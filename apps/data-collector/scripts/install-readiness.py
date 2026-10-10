#!/usr/bin/env python3
"""Apply reviewed Pi configuration. Does not create a research/production clock."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

REPO = Path('/home/bonzos/brti-edge')
STATE = Path('/var/lib/brti-w2ppp')
DATA = Path('/mnt/ssd/kalshi/w2ppp/data-collector')


def run(*cmd):
    return subprocess.run([str(c) for c in cmd], check=True, text=True, capture_output=True).stdout.strip()


def main():
    assert os.getuid() == 0 and run('hostname') == '1705bonzos'
    assert run('timedatectl', 'show', '-p', 'NTPSynchronized', '--value') == 'yes'
    assert run('findmnt', '-n', '-o', 'SOURCE', '--target', '/mnt/ssd') == '/dev/sda1'
    assert run('systemctl', 'is-enabled', 'pilot-kalshi.service') == 'masked'
    assert run('git', '-c', f'safe.directory={REPO}', '-C', REPO, 'status', '--porcelain', '--untracked-files=no') == ''
    assert not STATE.exists(), 'existing readiness state must never be replaced'
    STATE.mkdir(mode=0o755)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = STATE / 'preparation-backup'; backup.mkdir(mode=0o700)
    units = REPO / 'apps/data-collector/scripts/systemd'
    env = Path('/home/bonzos/.config/brti-edge/brti.env')
    shutil.copy2(env, backup / 'brti.env'); (backup / 'brti.env').chmod(0o600)
    historical = []
    for path in sorted((REPO / 'analysis/w2').glob('w2pp-*')):
        if path.is_file():
            historical.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
            shutil.copy2(path, backup / path.name)
    for name in ('kalshi-collector.service', 'kalshi-worker.service'):
        shutil.copy2(Path('/etc/systemd/system') / name, backup / name)
    run('systemctl', 'stop', 'kalshi-collector.service', 'kalshi-worker.service')
    DATA.mkdir(parents=True, mode=0o755)
    shutil.chown(DATA, user='bonzos', group='bonzos')
    lines = [line for line in env.read_text().splitlines() if not line.startswith('DATA_COLLECTOR_LOG_DIR=')]
    lines.append('DATA_COLLECTOR_LOG_DIR=' + str(DATA.resolve()))
    temp = env.with_name(env.name + '.readiness')
    temp.write_text('\n'.join(lines) + '\n'); shutil.copystat(env, temp); shutil.chown(temp, user='bonzos', group='bonzos')
    os.replace(temp, env)
    for name in ('kalshi-collector.service', 'kalshi-worker.service', 'w2ppp-prepare.service', 'w2ppp-prepare.timer'):
        shutil.copyfile(units / name, Path('/etc/systemd/system') / name)
    conf = Path('/etc/systemd/journald@brti-edge.conf.d'); conf.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(units / 'journald-brti-edge.conf', conf / 'limits.conf')
    run('systemctl', 'daemon-reload')
    run('systemd-analyze', 'verify', '/etc/systemd/system/kalshi-collector.service', '/etc/systemd/system/kalshi-worker.service', '/etc/systemd/system/w2ppp-prepare.service', '/etc/systemd/system/w2ppp-prepare.timer')
    run('systemctl', 'start', 'kalshi-collector.service', 'kalshi-worker.service')
    receipt = {'at': stamp, 'data_dir': str(DATA.resolve()), 'historical_close_files': historical,
               'historical_collector_archive': str(REPO / 'apps/data-collector/logs/data-collector'),
               'historical_ssd_archive': '/mnt/ssd/kalshi/data-collector',
               'new_collection': str(DATA), 'journal_namespace': 'brti-edge',
               'backup': str(backup), 'pilot_masked': True, 'production_round_started': False}
    (STATE / 'installation.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__': main()
