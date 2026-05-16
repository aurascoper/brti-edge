#!/usr/bin/env python3
"""Recompute per-asset YES bias from settled trades.

bias[asset] = mean(actual_yes - model_fair_yes_at_emit)

Positive bias → model understates YES probability for this asset.
The strategy applies: fair_yes_corrected = clamp(fair_yes + alpha × bias, 0.05, 0.95)
"""
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

STATE = Path('/Users/aurascoper/Developer/polyterminal/apps/market-worker/logs/kalshi-dust-state.json')
OUT = Path('/Users/aurascoper/Developer/polyterminal/apps/market-worker/logs/calibration.json')
MIN_N = 5

d = json.load(STATE.open())
filled = [c for c in d['candidates']
          if c.get('status') == 'filled'
          and c.get('realized_pnl_usd') is not None
          and c.get('ticker', '').startswith('KX')
          and c.get('fair_yes') is not None]

samples = defaultdict(list)
for c in filled:
    fair = c['fair_yes']
    won = c.get('realized_pnl_usd', 0) > 0
    side = c['side']
    actual_yes = 1 if (side == 'YES' and won) or (side == 'NO' and not won) else 0
    samples[c['series']].append(actual_yes - fair)

out = {
    'updated_at': datetime.now(timezone.utc).isoformat(),
    'min_sample_n': MIN_N,
    'bias_by_series': {},
    'sample_sizes': {},
}
for s, vals in samples.items():
    n = len(vals)
    out['sample_sizes'][s] = n
    if n >= MIN_N:
        out['bias_by_series'][s] = round(sum(vals) / n, 4)

OUT.write_text(json.dumps(out, indent=2))
print(f"Wrote {OUT}")
for s, b in sorted(out['bias_by_series'].items()):
    n = out['sample_sizes'][s]
    print(f"  {s:<11} n={n:<3} bias={b:+.4f}")
hidden = {s: n for s, n in out['sample_sizes'].items() if s not in out['bias_by_series']}
if hidden:
    print(f"  (insufficient sample, excluded: {hidden})")
