import copy
import gzip
import importlib.util
import json
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('w2ppp_prepare.py'))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)


def good():
    return {'shadow': {'ok': True}, 'collector': {'ok': True}, 'freeze': {'ok': True},
            'worker_env': {'ok': True}, 'collector_path_ok': True, 'gzip': {'ok': True},
            'reconciliation': {'integrity_ok': True, 'exchange': 120, 'missing': []}}


@pytest.mark.parametrize('key', ['shadow', 'collector', 'freeze', 'worker_env', 'gzip'])
def test_each_failed_soak_control_rejects_lock(key):
    health = good(); health[key]['ok'] = False; assert not p.eligible(health)


def test_soak_requires_complete_settlement_reconciliation():
    health = good(); assert p.eligible(health)
    health['reconciliation']['missing'] = ['one']; assert not p.eligible(health)
    health['reconciliation'].update(missing=[], exchange=0); assert not p.eligible(health)
    health['reconciliation'].update(exchange=120, integrity_ok=False); assert not p.eligible(health)


def test_soak_requires_same_collector_path():
    health = good(); health['collector_path_ok'] = False; assert not p.eligible(health)


def test_full_30_hours_gzip_trailers_and_nonempty_channels_required(tmp_path):
    start = p.epoch('2026-10-10T08:00:00Z'); end = start + 30 * 3600
    for i in range(30):
        for channel in ('orderbook-deltas', 'orderbook-snapshots'):
            hour = p.iso(start + i * 3600)[:13]
            with gzip.open(tmp_path / f'{channel}-{hour}.jsonl.gz', 'wt') as out: out.write('{"n":1}\n')
    assert p.gzip_check(tmp_path, start, end)['ok']
    broken = next(tmp_path.glob('orderbook-deltas*')); broken.write_bytes(b'')
    assert not p.gzip_check(tmp_path, start, end)['ok']


def test_failed_soak_is_not_restarted_by_tick(tmp_path, monkeypatch):
    monkeypatch.setattr(p, 'STATE', tmp_path)
    p.atomic(tmp_path / 'state.json', {'phase': 'NO-GO(soak)', 'problems': ['old failure']})
    p.atomic(tmp_path / 'config.json', {})
    monkeypatch.setattr(p, 'invariants', lambda _: pytest.fail('failed window cannot be reconsidered'))
    assert p.tick()['phase'] == 'NO-GO(soak)'


def test_less_than_30_hours_cannot_lock_or_schedule(tmp_path, monkeypatch):
    monkeypatch.setattr(p, 'STATE', tmp_path)
    p.atomic(tmp_path / 'state.json', {'phase': 'soak', 'restart': {'at': 'observed'}})
    p.atomic(tmp_path / 'config.json', {'start_at': '2026-10-10T08:00:00Z'})
    monkeypatch.setattr(p, 'invariants', lambda _: [])
    monkeypatch.setattr(p.time, 'time', lambda: p.epoch('2026-10-11T13:59:59Z'))
    monkeypatch.setattr(p, 'install_timers', lambda *a: pytest.fail('early lock'))
    assert p.tick()['phase'] == 'soak' and not (tmp_path / 'lock.json').exists()


def test_any_integrity_problem_is_terminal_before_or_after_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(p, 'STATE', tmp_path); p.atomic(tmp_path / 'config.json', {})
    monkeypatch.setattr(p, 'invariants', lambda _: ['host_reboot'])
    for phase, result in [('soak', 'NO-GO(soak)'), ('holdout', 'VOID(host-integrity)')]:
        p.atomic(tmp_path / 'state.json', {'phase': phase})
        assert p.tick()['phase'] == result
