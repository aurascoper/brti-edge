#!/usr/bin/env python3
"""Render review-only units. Never install, reload, enable, or start services."""
import argparse
import re
from pathlib import Path, PurePosixPath


def path(value):
    if (
        not re.fullmatch(r'/[A-Za-z0-9_./-]+', value)
        or '..' in PurePosixPath(value).parts
        or str(PurePosixPath(value)) != value
    ):
        raise argparse.ArgumentTypeError(
            'Use an absolute normalized path with no spaces or shell metacharacters'
        )
    return value


def render(a):
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', a.user) or a.user == 'root':
        raise ValueError('A dedicated non-root user is required')
    if not re.fullmatch(r'[A-Za-z0-9-]+', a.uuid) or a.uuid == 'UNVERIFIED':
        raise ValueError('Provide independently attested healthy filesystem UUID')
    if (
        a.mount == '/'
        or not PurePosixPath(a.repo).is_relative_to(a.mount)
        or a.repo == a.mount
    ):
        raise ValueError('Repository must be below the explicitly approved mount, not root')
    if a.min_free_gib < 1:
        raise ValueError('Positive minimum free-space threshold required')
    dc = a.repo + '/apps/data-collector'
    mw = a.repo + '/apps/market-worker'
    for name, app, launcher, logdir, key, stop, envfile, out, err in [
        (
            'kalshi-collector',
            dc,
            'run-collector-supervised.sh',
            dc + '/logs/data-collector',
            'DATA_COLLECTOR_LOG_DIR',
            30,
            a.env_file,
            dc + '/ops/state/launchd-collector.out.log',
            dc + '/ops/state/launchd-collector.err.log',
        ),
        (
            'kalshi-worker',
            mw,
            'run-worker-shadow.sh',
            mw + '/logs',
            'NONE',
            10,
            a.env_file,
            mw + '/logs/launchd-kalshi-worker.out.log',
            mw + '/logs/launchd-kalshi-worker.err.log',
        ),
        (
            'pm-collector',
            dc,
            'run-polymarket-collector.sh',
            dc + '/logs/polymarket',
            'PM_COLLECTOR_LOG_DIR',
            30,
            None,
            None,
            None,
        ),
    ]:
        env = f'EnvironmentFile={envfile}\n' if envfile else ''
        logenv = f'Environment={key}={logdir}\n' if key != 'NONE' else ''
        # Worker launcher independently re-pins the three flags after dotenv.
        # Do not open append logs before mount guard has passed.
        redirects = f' >>{out} 2>>{err}' if out else ''
        check = (
            f'/usr/bin/bash {a.guard} {a.mount} {a.uuid} {a.repo} '
            f'{app} {logdir} {key} {a.min_free_gib}'
        )
        launch = f'/usr/bin/bash {app}/scripts/{launcher}'
        yield (
            name + '.service',
            f'''# REVIEW ONLY. No [Install] section. Do not start during Stage 0.
[Unit]
Description=RFAS {name} (review-only candidate)
Wants=network-online.target time-sync.target
After=network-online.target time-sync.target
RequiresMountsFor={a.mount} {a.repo}
ConditionHost=ok-computer
# A separately authorized cutover must supply this root-controlled marker.
ConditionPathExists=/etc/brti-edge/collector-cutover-approved

[Service]
Type=simple
User={a.user}
WorkingDirectory={app}
{env}Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=KALSHI_ALLOW_ORDERS=0 KALSHI_AUTO_SUBMIT=0 KALSHI_DUST_ENABLED=0
{logenv}ExecStartPre=/usr/bin/bash {a.guard} {a.mount} {a.uuid} {a.repo} {app} {logdir} {key} {a.min_free_gib}
ExecStartPre=/usr/bin/bash -c 'until timedatectl show -p NTPSynchronized --value | grep -qx yes; do sleep 5; done'
TimeoutStartSec=infinity
ExecStart=/usr/bin/bash -c '{check} && exec {launch}{redirects}'
Restart=always
RestartSec=30
KillMode=mixed
TimeoutStopSec={stop}
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
UMask=0077
''',
        )


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--user', required=True)
    p.add_argument('--repo', type=path, required=True)
    p.add_argument('--mount', type=path, required=True)
    p.add_argument('--uuid', required=True)
    p.add_argument('--env-file', type=path, required=True)
    p.add_argument('--guard', type=path, required=True)
    p.add_argument('--min-free-gib', type=int, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    units = list(render(a))
    a.output.mkdir(parents=True, exist_ok=False)
    for name, body in units:
        (a.output / name).write_text(body)
    print('Rendered 3 REVIEW ONLY units; no host or service state changed.')
