import gzip
import json
import os
from pathlib import Path
import subprocess

SRC = Path(__file__).resolve().parents[1] / 'src/persistence.ts'


def node(body):
    result = subprocess.run(['node', '--input-type=module', '-e', f'import {{ GzipRotator }} from "{SRC}";\n' + body], capture_output=True, text=True, timeout=20)
    assert 'SyntaxError' not in result.stderr
    return result


def test_sustained_backpressure_is_rate_limited(tmp_path):
    result = node(f'''
const r = new GzipRotator({{logDir:{json.dumps(str(tmp_path))},channel:'orderbook-deltas'}});
r.write({{n:0}});
const gz = r.state.gz, write = gz.write.bind(gz);
gz.write = (...args) => {{ write(...args); return false; }};
let t=Date.now(); Date.now=()=>t;
for(let i=0;i<1000;i++)r.write({{i}});
t+=30000;r.write({{n:1001}});
await r.closeAsync();
''')
    assert result.returncode == 0, result.stderr
    assert result.stderr.count('gzip backpressure') == 2
    assert '1000 writes since warning' in result.stderr


def test_gzip_utc_rotation_and_restart_are_complete(tmp_path):
    result = node(f'''
const RealDate=Date;let t=Date.parse('2026-10-10T08:59:59Z');
globalThis.Date=class extends RealDate {{constructor(...a){{super(...(a.length?a:[t]));}}static now(){{return t;}}}};
const opts={{logDir:{json.dumps(str(tmp_path))},channel:'orderbook-deltas'}};
const r=new GzipRotator(opts);r.write({{n:1}});t+=2000;r.write({{n:2}});await r.closeAsync();
const restarted=new GzipRotator(opts);restarted.write({{n:3}});await restarted.closeAsync();
''')
    assert result.returncode == 0, result.stderr
    paths = sorted(tmp_path.glob('*.gz'))
    assert len(paths) == 3 and any('.p2.' in p.name for p in paths)
    rows = [json.loads(line) for p in paths for line in gzip.open(p, 'rt')]
    assert sorted(row['n'] for row in rows) == [1, 2, 3]


def test_compressor_failure_during_shutdown_exits_visibly(tmp_path):
    result = node(f'''
const r=new GzipRotator({{logDir:{json.dumps(str(tmp_path))},channel:'orderbook-deltas'}});r.write({{n:1}});
const gz=r.state.gz;r.close();gz.emit('error',Object.assign(new Error('synthetic compressor'),{{code:'EIO'}}));
''')
    assert result.returncode == 1 and 'FATAL orderbook-deltas' in result.stderr


def test_unwritable_sink_exits_visibly(tmp_path):
    # A regular file as directory is unwritable regardless of the test UID.
    sink = tmp_path / 'file'; sink.write_text('x')
    result = node(f'const r=new GzipRotator({{logDir:{json.dumps(str(sink))},channel:"orderbook-deltas"}});r.write({{n:1}});')
    assert result.returncode == 1 and 'FATAL orderbook-deltas' in result.stderr


def test_journal_limits_and_health_loop_has_no_log_copying():
    scripts = SRC.parent.parent / 'scripts'
    unit = (scripts / 'systemd/kalshi-collector.service').read_text()
    conf = (scripts / 'systemd/journald-brti-edge.conf').read_text()
    assert 'LogNamespace=brti-edge' in unit and 'StandardError=journal' in unit
    assert 'SystemMaxUse=64M' in conf and 'RuntimeMaxUse=16M' in conf
    loop = (scripts / 'run-collector-supervised.sh').read_text().split('# inner health-watch loop')[1]
    assert 'cap_err_log' not in loop
