# Autoresearch — Candidate 3: Cap + Edge-Floor Replay (polyterminal / brti-edge)

You are running an autonomous experiment loop. Your job is to find a `(FAIR_MIN, FAIR_MAX, EDGE_FLOOR, SAFETY_BUFFER)` configuration that, when REPLAYED against the 287 historical filled trades, produces **positive total PnL** without overfitting to one asset or one time period.

## Why this run exists

Layer-2 feature autoresearch (Candidate 1) completed 30 iterations without clearing the gate — basis/funding features didn't add 5pp of Brier skill on the executable-proxy universe. The next-best lever is **strategy-side filtering**: tighten the existing `fairValueArbCapped*` cap range and the live `EDGE_FLOOR` / `SAFETY_BUFFER` constants to see if there's a subset of the 287 historical opportunities that, in aggregate, would have been profitable.

This is a DEFENSIVE optimization — it can only filter trades OUT, never add new ones. The 287 trades are the trades the LIVE strategy actually accepted across R1–R6 (net $-34.05 PnL). The replay asks: "if a tighter config had been live, which subset would have been kept, and was that subset profitable?"

## What you change

**One file type only:** `autoresearch_caps/configs/<your_config_name>.json`

A new config per iteration. Format:
```json
{
  "name": "iter_05_edge0.04_cap0.30_0.70",
  "fair_min": 0.30,
  "fair_max": 0.70,
  "edge_floor": 0.04,
  "safety_buffer": 0.005
}
```

### Allowed parameter ranges (validator enforces)

| Field | Range | Live default |
|---|---|---|
| `fair_min` | `0.0 <= fair_min < fair_max` | 0.0 |
| `fair_max` | `fair_min < fair_max <= 1.0` | 1.0 |
| `edge_floor` | `[0.0, 0.30]` | 0.0075 |
| `safety_buffer` | `[0.0, 0.05]` | 0.005 |

Trade-accept rule (per historical trade):
```
fair_clamped = clip(fair_yes, fair_min, fair_max)
edge = (fair_clamped - ask_price)            if side == YES
edge = ((1 - fair_clamped) - ask_price)      if side == NO
KEEP iff edge >= safety_buffer + edge_floor
```

## What you DO NOT touch

- `apps/market-worker/**` — worker code, off-limits.
- `apps/web/**`, `packages/**` — off-limits.
- `apps/market-worker/logs/**` — the frozen ledger.
- `docs/run-ledgers/**`.
- `.env*` — no env-var changes.
- `autoresearch_caps/score.py` — read-only.
- `autoresearch_layer2/**` — the Layer-2 harness is sibling work, leave it alone.

This loop is config-only.

## How to run

```bash
cd /Users/aurascoper/Developer/polyterminal
python3 autoresearch_caps/score.py autoresearch_caps/configs/<your_config_name>.json
```

Final line prints `SCORE: <float>` — the **total replay PnL in dollars** across retained trades.

Full JSON result also written to `analysis/brier/autoresearch_caps_<name>.json`.

## Pass condition (all six must hold)

| Gate | Threshold | Meaning |
|---|---|---|
| `pnl_positive` | PnL > 0 | Total replay PnL is positive (baseline = $-34.05) |
| `ci_excludes_zero` | bootstrap CI low > 0 | 95% bootstrap CI on the retained-set PnL excludes zero |
| `retention_ok` | n_retained ≥ 50 | Keep at least 50 trades (don't degenerate to "skip almost everything") |
| `no_single_asset_dominance` | top asset share ≤ 0.60 | No single series accounts for >60% of the improvement over baseline |
| `no_single_fold_dominance` | top fold share ≤ 0.50 | No single time-fold (of 4 equal time-ordered quartiles) > 50% of the improvement |
| `improves_over_baseline` | delta_pnl > 0 | Candidate PnL exceeds baseline PnL of $-34.05 |

A config that fails any gate is not a passing config, even if PnL is high.

**Important nuance on dominance:** the per-fold breakdown uses time-ordered quartiles. f4 (the most recent quartile) was R4's Kelly-overbet disaster. Just dropping f4 entirely would trivially "improve" PnL but is the textbook overfit. The fold-dominance gate exists to catch this.

## Strategy (ordered)

The search space is small (4 parameters, ~2k combinations total). Each `score.py` invocation takes < 1 second. The strategy is one-parameter-at-a-time gradient-style search:

1. **Confirm baseline.** Run `configs/baseline.json` (live params). Expect PnL = $-34.05, delta = 0. Confirms wiring.

2. **EDGE_FLOOR sweep** (iters 1–7): Keep `fair_min=0, fair_max=1, safety_buffer=0.005`. Try `edge_floor ∈ {0.015, 0.025, 0.04, 0.06, 0.08, 0.10, 0.15}`. Find the value that maximizes PnL without breaking dominance gates.

3. **SAFETY_BUFFER sweep** (iters 8–12): At best `edge_floor`, sweep `safety_buffer ∈ {0.0, 0.0025, 0.01, 0.015, 0.02}`. Small effect expected.

4. **FAIR_MAX sweep** (iters 13–19): At best `(edge_floor, safety_buffer)`, sweep `fair_max ∈ {0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.95}`. Caps overconfident YES predictions.

5. **FAIR_MIN sweep** (iters 20–26): At best `(fair_max, edge_floor, safety_buffer)`, sweep `fair_min ∈ {0.05, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45}`. Caps overconfident NO predictions.

6. **Combinations** (iters 27–30): Try the joint best, plus 2-3 perturbations to test stability.

**Stop conditions:**
- A config passes ALL six gates → run 2 confirmation perturbations (vary one parameter by ±1 grid step). Both must also pass.
- 30 iterations elapsed with no pass → write the final report.

## What to watch for

- **f4 dominance.** R4's Kelly-overbet loss is concentrated in fold 4. Any config that "improves" by dropping mostly f4 trades will trigger `no_single_fold_dominance`. This is the most common failure mode.
- **KXBTC dominance.** BTC had 83 trades and lost $-27.10; dropping BTC alone "improves" PnL by ~$27 but concentrates risk on one asset. Watch `largest_asset`.
- **Sample shrinkage.** Tight caps + high edge floors quickly drop n_retained below 50. The retention gate is intentionally conservative.
- **CI excluding zero.** Bootstrap CI is wide ($-87 to $+17 for baseline). Small improvements are noise; pass requires both PnL > 0 AND CI low > 0.

## State tracking

Each iteration appends one JSON line to `autoresearch_caps/state/autoresearch.jsonl`:
```json
{"type": "result", "iteration": 1, "config_name": "iter_01_edge0.015", "pnl": -23.41, "delta_pnl": +10.64, "n_retained": 256, "ci_low": -67.2, "ci_high": +18.4, "passes_all_gates": false, "pass_flags": {...}, "status": "discard", "description": "edge_floor=0.015 raised from 0.0075", "timestamp": "..."}
```

Update `autoresearch_caps/state/autoresearch_dashboard.md` after every iteration.

If you lose context, re-read `autoresearch.jsonl` + dashboard to recover. Line 0 = config header.

## Determinism

- Fixed seed 42 for bootstrap.
- No randomness elsewhere.
- `score.py --selftest` confirms identical results across 3 runs.

## When you find a passing config

Write `autoresearch_caps/state/final_report.md` with:

1. Winning config + per-flag block
2. Replay PnL, retention, win rate
3. Per-asset table
4. Per-fold table
5. Bootstrap CI
6. Confirmation perturbations
7. **Recommendation to operator** — research finding only. Live trading remains paused; operator decides whether to update strategy constants for R7.

Do NOT modify any worker code, env vars, or ledgers.
