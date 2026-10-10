#!/usr/bin/env python3
"""One durable soak, then one frozen W2 triple-prime window. Never arms orders.

Run by a root-owned timer; exchange and source checks run as the producer owner.
Failures are terminal records. Restarting this program cannot restart a window.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import stat
import time
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
STATE = Path('/var/lib/brti-w2ppp')


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def epoch(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def atomic(path, value):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    with tmp.open('x') as f:
        json.dump(value, f, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def run(*args, owner=False, check=True):
    cmd = [str(a) for a in args]
    if owner: cmd = ['runuser', '-u', 'bonzos', '--', *cmd]
    return subprocess.run(cmd, text=True, capture_output=True, check=check, timeout=600)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def next_hour(t):
    return (int(t) // 3600 + 1) * 3600


def eligible(health):
    return (health['shadow']['ok'] and health['collector']['ok']
            and health['reconciliation']['integrity_ok']
            and health['reconciliation']['exchange'] > 0
            and not health['reconciliation']['missing']
            and health['freeze']['ok'] and health['worker_env']['ok']
            and health['collector_path_ok'] and health['gzip']['ok'])


def gzip_check(data_dir, start, end):
    """Stricter pre-lock plumbing check; published holdout G4 is unchanged."""
    files, errors, hours = [], [], {}
    for channel in ('orderbook-deltas', 'orderbook-snapshots'):
        hours[channel] = []
        for path in sorted(Path(data_dir).glob(channel + '-*.jsonl.gz')):
            hour = path.name[len(channel) + 1:len(channel) + 14]
            t = epoch(hour + ':00:00Z')
            if not start <= t < end: continue
            try:
                lines = 0
                with gzip.open(path, 'rt') as stream:
                    for line in stream:
                        json.loads(line); lines += 1
                if not lines: raise ValueError('empty segment')
                files.append(path.name)
                hours[channel].append(hour)
            except (OSError, EOFError, ValueError) as exc:
                errors.append({'file': path.name, 'error': type(exc).__name__})
    return {'ok': bool(files) and not errors and all(len(set(v)) >= 30 for v in hours.values()),
            'files': files, 'errors': errors, 'distinct_hours': {k: len(set(v)) for k, v in hours.items()}}


def health(config, end):
    import w2_close_check as close
    os.environ['DATA_COLLECTOR_LOG_DIR'] = config['data_dir']
    close.COLLECTOR_LOGS = config['data_dir']
    start = epoch(config['start_at']); t0, t1 = start * 1000, end * 1000
    listing = close.fetch_settled_listing(t0 - close.LISTING_PAD_MS, t1 + close.LISTING_PAD_MS)
    selected = [m for m in listing if m.get('close_time') and t0 <= close.ts_ms(m['close_time']) <= t1]
    excluded = close.excluded_intervals(listing, t0, t1)
    vector = json.loads((HERE / 'w2ppp-env-vector.json').read_text())
    collectors = close.worker_environs_for_collector()
    return {'since': iso(start), 'until': iso(end), 'listing': selected,
            'shadow': close.check_shadow_continuity(t0, t1, excluded),
            'collector': close.check_collector_hours(t0, t1, excluded),
            'reconciliation': close.reconcile(selected, t0, t1),
            'freeze': close.check_freeze(config['instrument_tag']),
            'worker_env': close.check_worker_env(close.worker_environs(), vector, close.API_BASE),
            'collector_path_ok': bool(collectors) and all(e.get('DATA_COLLECTOR_LOG_DIR') == config['data_dir'] for e in collectors.values()),
            'gzip': gzip_check(config['data_dir'], start, end)}


def dust_allowed(config, now=None):
    """A single pinned soak test may run; holdout always requires the mask."""
    now = time.time() if now is None else now
    if not config.get('dust_authorization_sha256'): return False
    try:
        authorization = STATE / 'dust-authorization.json'
        record_path = STATE / 'dust-run.json'
        for path in (authorization, record_path):
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: return False
        if sha(authorization) != config['dust_authorization_sha256']: return False
        auth = json.loads(authorization.read_text()); status = json.loads(record_path.read_text())
        if (auth.get('source_pin') != config['source_pin'] or auth.get('starts_at') != config['start_at']
                or auth.get('promotion_gate') != 'fourteen-day-G1-G7' or auth.get('research_go') is not False
                or epoch(auth['ends_at']) - epoch(auth['starts_at']) != 48 * 3600
                or not epoch(auth['starts_at']) <= now < epoch(auth['ends_at'])
                or status.get('phase') not in ('active', 'activating')
                or status.get('authorization_sha256') != config['dust_authorization_sha256']
                or sha(config['dust_runtime']) != config['dust_runtime_sha256']): return False
        return True
    except (OSError, ValueError, KeyError, TypeError): return False


def invariants(config, allow_dust=True):
    problems = []
    if run('timedatectl', 'show', '-p', 'NTPSynchronized', '--value').stdout.strip() != 'yes': problems.append('time_unsynchronized')
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != config['boot_id']: problems.append('host_reboot')
    source = run('findmnt', '-n', '-o', 'SOURCE,UUID', '--target', config['data_dir']).stdout.strip()
    if source != config['mount_identity'] or not source.startswith('/dev/sda1 '): problems.append('ssd_mount_changed')
    for unit in ('kalshi-collector.service', 'kalshi-worker.service'):
        if run('systemctl', 'is-active', unit, check=False).stdout.strip() != 'active': problems.append(unit + '_inactive')
    for filename, expected in config.get('installed_files', {}).items():
        try:
            if sha(filename) != expected: problems.append('installed_configuration_changed:' + filename)
        except OSError: problems.append('installed_configuration_missing:' + filename)
    if not (allow_dust and dust_allowed(config)):
        if run('systemctl', 'is-enabled', 'pilot-kalshi.service', check=False).stdout.strip() != 'masked': problems.append('pilot_not_masked')
        if run('systemctl', 'is-active', 'pilot-kalshi.service', check=False).stdout.strip() != 'inactive': problems.append('pilot_not_inactive')
    import w2_close_check as close
    vector = json.loads((HERE / 'w2ppp-env-vector.json').read_text())
    if not close.check_worker_env(close.worker_environs(), vector, close.API_BASE)['ok']: problems.append('worker_env_changed')
    frozen = run(sys.executable, '-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import w2_close_check as c;print(json.dumps(c.check_freeze(sys.argv[2])))', HERE, config['instrument_tag'], owner=True)
    if not json.loads(frozen.stdout)['ok']: problems.append('frozen_source_changed')
    return problems


def install_timers(config, lock):
    """Existing mechanical wrapper, exact span; no bare scorer or activation."""
    repo = config['repo']; since = lock['since']; tag = config['instrument_tag']
    for kind, days in (('day7-interim', 7), ('close', 14)):
        until = iso(epoch(since) + days * 86400)
        name = 'w2ppp-' + kind
        cmd = f'/usr/bin/python3 {HERE}/w2ppp_prepare.py --state-dir {STATE} report --kind {kind}'
        service = f'[Unit]\nDescription=W2 triple-prime {kind} mechanical wrapper\n[Service]\nType=oneshot\nExecStart={cmd}\nTimeoutStartSec=1800\n'
        when = iso(epoch(until) + 300).replace('T', ' ').replace('Z', ' UTC')
        timer = f'[Unit]\nDescription=W2 triple-prime {kind}\n[Timer]\nOnCalendar={when}\nPersistent=true\n[Install]\nWantedBy=timers.target\n'
        Path('/etc/systemd/system/' + name + '.service').write_text(service)
        Path('/etc/systemd/system/' + name + '.timer').write_text(timer)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'w2ppp-day7-interim.timer', 'w2ppp-close.timer')


def fail(state, phase, problems):
    state.update(phase=phase, failed_at=iso(time.time()), problems=problems)
    atomic(STATE / 'state.json', state)
    return state


def begin(tag):
    if (STATE / 'config.json').exists() or (STATE / 'state.json').exists():
        raise ValueError('existing_soak_or_window_must_not_be_replaced')
    repo = str(HERE.parents[2])
    source = run('git', '-C', repo, 'rev-parse', 'HEAD', owner=True).stdout.strip()
    tagged = run('git', '-C', repo, 'rev-parse', tag + '^{commit}', owner=True).stdout.strip()
    if source != tagged: raise ValueError('instrument_tag_must_name_installed_head')
    vector = json.loads((HERE / 'w2ppp-env-vector.json').read_text())
    att = json.loads(Path('/var/lib/obi-kalshi-source/producer.json').read_text())
    installed = {}
    for name in ('kalshi-collector.service', 'kalshi-worker.service', 'w2ppp-prepare.service', 'w2ppp-prepare.timer'):
        path = Path('/etc/systemd/system') / name
        if path.read_bytes() != (Path(repo) / 'apps/data-collector/scripts/systemd' / name).read_bytes():
            raise ValueError('installed_unit_differs:' + name)
        installed[str(path)] = sha(path)
    journal = '/etc/systemd/journald@brti-edge.conf.d/limits.conf'
    if Path(journal).read_bytes() != (Path(repo) / 'apps/data-collector/scripts/systemd/journald-brti-edge.conf').read_bytes():
        raise ValueError('installed_journal_limits_differ')
    installed[journal] = sha(journal)
    config = {'start_at': iso(next_hour(time.time())), 'instrument_tag': tag, 'repo': repo,
              'source': source, 'data_dir': vector['DATA_COLLECTOR_LOG_DIR'],
              'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
              'mount_identity': run('findmnt', '-n', '-o', 'SOURCE,UUID', '--target', vector['DATA_COLLECTOR_LOG_DIR']).stdout.strip(),
              'source_pin': att['source_pin'], 'installed_files': installed}
    authorization = STATE / 'dust-authorization.json'
    if authorization.exists():
        auth = json.loads(authorization.read_text())
        if auth['starts_at'] != config['start_at']: raise ValueError('dust_and_soak_start_must_match')
        runtime = Path('/opt/obi-kalshi/current/scripts/kalshi_dust_round.py').resolve(strict=True)
        config.update(dust_authorization_sha256=sha(authorization), dust_runtime=str(runtime),
                      dust_runtime_sha256=sha(runtime))
        for name in ('kalshi-dust-start.service', 'kalshi-dust-start.timer',
                     'kalshi-dust-monitor.service', 'kalshi-dust-monitor.timer'):
            path = Path('/etc/systemd/system') / name
            if path.read_bytes() != (runtime.parents[1] / 'systemd' / name).read_bytes():
                raise ValueError('installed_dust_unit_differs:' + name)
            config['installed_files'][str(path)] = sha(path)
    problems = invariants(config, allow_dust=False)
    if problems: raise ValueError('pre_soak_invariants_failed:' + ','.join(problems))
    atomic(STATE / 'config.json', config)
    state = {'phase': 'soak', 'prepared_at': iso(time.time()), 'start_at': config['start_at']}
    atomic(STATE / 'state.json', state)
    run('systemctl', 'enable', '--now', 'w2ppp-prepare.timer')
    return state


def tick():
    config = json.loads((STATE / 'config.json').read_text())
    state = json.loads((STATE / 'state.json').read_text())
    if state['phase'] not in ('soak', 'holdout'): return state
    problems = invariants(config) if state['phase'] == 'soak' else invariants(config, allow_dust=False)
    if problems: return fail(state, 'NO-GO(soak)' if state['phase'] == 'soak' else 'VOID(host-integrity)', problems)
    now = time.time(); start = epoch(config['start_at'])
    if state['phase'] == 'holdout':
        state['last_checked_at'] = iso(now); atomic(STATE / 'state.json', state); return state
    if now >= start + 3600 + 300 and not state.get('restart'):
        before = run('systemctl', 'show', 'kalshi-collector', '-p', 'MainPID', '--value').stdout.strip()
        run('systemctl', 'restart', 'kalshi-collector.service')
        after = run('systemctl', 'show', 'kalshi-collector', '-p', 'MainPID', '--value').stdout.strip()
        if before == after or after == '0': return fail(state, 'NO-GO(soak)', ['restart_not_observed'])
        state['restart'] = {'at': iso(now), 'before_pid': before, 'after_pid': after}
        atomic(STATE / 'state.json', state)
    end = start + 30 * 3600
    if now < end + 300: return state
    if dust_allowed(config):
        state['awaiting_dust_endpoint'] = iso(now); atomic(STATE / 'state.json', state); return state
    if config.get('dust_authorization_sha256'):
        dust = json.loads((STATE / 'dust-run.json').read_text())
        if dust.get('phase') in ('FAIL', 'START_FAILED', 'NO_START'):
            return fail(state, 'NO-GO(soak)', ['dust_execution_acceptance_failed:' + dust['phase']])
        if dust.get('phase') != 'ended': return fail(state, 'NO-GO(soak)', ['dust_endpoint_not_recorded'])
    result = run(sys.executable, HERE / 'w2ppp_prepare.py', 'health', '--config', STATE / 'config.json', '--end', iso(end), owner=True)
    checks = json.loads(result.stdout)
    atomic(STATE / 'soak-receipt.json', checks)
    if not state.get('restart') or not eligible(checks): return fail(state, 'NO-GO(soak)', ['prelock_acceptance_failed'])
    since = iso(next_hour(time.time()))
    lock = {'name': 'W2 triple-prime', 'since': since, 'until': iso(epoch(since) + 14 * 86400),
            'instrument_tag': config['instrument_tag'], 'data_dir': config['data_dir'],
            'soak_receipt_sha256': sha(STATE / 'soak-receipt.json'), 'source': config['source'],
            'thresholds': 'Published G1-G7 unchanged; published pause exclusions unchanged',
            'pilot_masked': True, 'authoritative_host': '1705bonzos'}
    lock_path = Path(config['repo']) / 'docs/research/w2ppp-lock.json'
    if lock_path.exists(): return fail(state, 'NO-GO(soak)', ['lock_already_exists'])
    # Producer owns its checkout. Commit/tag BEFORE its first eligible boundary.
    run('runuser', '-u', 'bonzos', '--', 'python3', '-c',
        'import json,sys; from pathlib import Path; Path(sys.argv[1]).write_text(json.dumps(json.loads(sys.argv[2]),indent=2)+"\\n")', lock_path, json.dumps(lock))
    run('git', '-C', config['repo'], 'add', 'docs/research/w2ppp-lock.json', owner=True)
    run('git', '-C', config['repo'], '-c', 'user.name=BTC dust readiness', '-c', 'user.email=readiness@localhost', 'commit', '-m', 'Lock W2 triple-prime after eligible 30-hour soak', owner=True)
    lock_tag = 'w2ppp-lock-' + since.replace('-', '').replace(':', '')
    run('git', '-C', config['repo'], '-c', 'user.name=BTC dust readiness', '-c', 'user.email=readiness@localhost', 'tag', '-a', lock_tag, '-m', 'W2 triple-prime frozen window', owner=True)
    if time.time() >= epoch(since): return fail(state, 'NO-GO(soak)', ['lock_missed_boundary'])
    atomic(STATE / 'lock.json', lock)
    install_timers(config, lock)
    state.update(phase='holdout', lock=lock, lock_tag=lock_tag, locked_at=iso(time.time()))
    atomic(STATE / 'state.json', state)
    return state


def report(kind):
    config = json.loads((STATE / 'config.json').read_text())
    lock = json.loads((STATE / 'lock.json').read_text())
    state = json.loads((STATE / 'state.json').read_text())
    days = 7 if kind == 'day7-interim' else 14
    until = iso(epoch(lock['since']) + days * 86400)
    if time.time() < epoch(until) + 300: raise ValueError('report_before_endpoint')
    path = STATE / (kind + '-receipt.json')
    if path.exists(): return json.loads(path.read_text())
    cmd = ['env', 'DATA_COLLECTOR_LOG_DIR=' + config['data_dir'], 'KALSHI_API_BASE=https://api.elections.kalshi.com/trade-api/v2',
           sys.executable, HERE / 'w2_close_check.py', '--since', lock['since'], '--until', until,
           '--tag', config['instrument_tag'], '--env-vector', HERE / 'w2ppp-env-vector.json']
    if days == 7: cmd.append('--interim')
    proc = run(*cmd, owner=True, check=False)
    out = STATE / (kind + '.txt'); out.write_text(proc.stdout + proc.stderr)
    problems = invariants(config, allow_dust=False)
    go = days == 14 and state['phase'] == 'holdout' and not problems and proc.returncode == 0 and '\nVERDICT: GO — full battery PASS on an eligible, frozen window' in proc.stdout
    receipt = {'schema': 1, 'kind': kind, 'at': iso(time.time()), 'since': lock['since'], 'until': until,
               'verdict': 'GO' if go else ('CONTINUE' if days == 7 and proc.returncode == 0 else 'NO-GO'),
               'returncode': proc.returncode, 'problems': problems, 'stdout_sha256': sha(out),
               'data_dir': config['data_dir'], 'instrument_tag': config['instrument_tag'],
               'source_pin': config['source_pin'], 'authoritative_host': '1705bonzos'}
    atomic(path, receipt)
    if go: atomic(STATE / 'stage-a-go.json', receipt)
    if days == 14:
        state.update(phase='GO' if go else 'NO-GO(holdout)', report=str(path)); atomic(STATE / 'state.json', state)
    return receipt


def main():
    global STATE
    ap = argparse.ArgumentParser(); ap.add_argument('--state-dir', default=str(STATE))
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('tick')
    p = sub.add_parser('begin'); p.add_argument('--instrument-tag', required=True)
    p = sub.add_parser('health'); p.add_argument('--config', required=True); p.add_argument('--end', required=True)
    p = sub.add_parser('report'); p.add_argument('--kind', choices=('day7-interim', 'close'), required=True)
    args = ap.parse_args(); STATE = Path(args.state_dir)
    if args.cmd == 'health': result = health(json.loads(Path(args.config).read_text()), epoch(args.end))
    else:
        if os.getuid() != 0: raise ValueError('root_controller_required')
        # Timer and close jobs serialize all durable transitions.
        import fcntl
        with (STATE / 'controller.lock').open('a') as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            try:
                result = begin(args.instrument_tag) if args.cmd == 'begin' else (tick() if args.cmd == 'tick' else report(args.kind))
            except Exception as exc:
                if not (STATE / 'state.json').exists(): raise
                state = json.loads((STATE / 'state.json').read_text())
                if state['phase'] in ('soak', 'holdout'):
                    result = fail(state, 'NO-GO(soak)' if state['phase'] == 'soak' else 'NO-GO(holdout)', [type(exc).__name__])
                else: raise
    print(json.dumps(result))


if __name__ == '__main__': main()
