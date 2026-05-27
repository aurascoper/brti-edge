# Autoresearch — Layer-2 Feature Bakeoff (polyterminal / brti-edge)

You are running an autonomous experiment loop. Your job is to find a Layer-2 model configuration that produces ≥ 5 percentage points of **ΔBrier-skill** lift over the Gaussian-only baseline, measured on the **executable-proxy universe** — without overfitting to a single asset or a single fold, and producing positive simulated net edge after fees.

## Why the metric is ΔBrier-skill on a filtered subset (read this once)

The full `shadow_with_basis` universe is dominated by trivially-decided 95/5 markets — the baseline Gaussian already scores ~73% skill there, so a 5% absolute gate is meaningless. The executable proxy filters to `p_gaussian ∈ [0.20, 0.80]` AND `secs_to_close >= 90s`, which approximates the close-to-50/50 markets the live executor would consider. Baseline skill on this subset is near zero, so a 5pp ΔBrier-skill lift is a real signal.

The full shadow universe is still computed for diagnostics — to verify the model isn't accidentally worse on the easy markets — but it does NOT decide pass/fail.

## System context

Kalshi 15-min crypto binaries. The deployed worker prices each binary with a point-digital Gaussian model `p_gaussian = Φ(z)`. Layer 1 (post-hoc transforms of `p_gaussian`) failed the gate at 0.93% skill on the filled universe. Layer 2 augments the model with candidate features collected in shadow:

- `basis_bps` — spot-perp basis at decision time (bps)
- `funding_rate` — perp funding rate at decision time
- `basis_change_bps` — derived: ticker's basis_bps minus the previous shadow tick for the same asset (computed in `score.py`, not in the worker)

The decision-time row is the smallest `secs_to_close >= 90s` per ticker (matches the live executor's gate). **You must not change this.**

## What you change

**One file type only:** `autoresearch_layer2/configs/<your_config_name>.json`

A new config per iteration. Configs are JSON of the form:
```json
{
  "name": "iter_03_basis_zscore_C0.1",
  "features": ["basis_bps", "funding_rate"],
  "transforms": {"basis_bps": "zscore", "funding_rate": "raw"},
  "interactions": [["basis_bps", "funding_rate"]],
  "C": 0.1,
  "include_student_t": false,
  "student_t_grid": null
}
```

### Allowed search space

| Field | Allowed values |
|---|---|
| `features` | any subset of `["basis_bps", "funding_rate", "basis_change_bps"]`. Empty = baseline. |
| `transforms[<f>]` | `"raw"`, `"zscore"`, `"winsor"` (1st/99th pctile, fit on train) |
| `interactions` | list of `[f1, f2]` pairs where both `f1` and `f2` are already in `features` |
| `C` | logistic regularization, in `(0, 1e6]`. Log-spaced search over `[1e-3, 1e2]` recommended. |
| `include_student_t` | bool. Runs Student-t calibration sweep on the primary executable proxy as a parallel branch. |
| `student_t_grid` | `{"nu": [...], "beta": [...], "alpha": [...]}` — finer than `STUDENT_GRID` in brier_bakeoff.py |

The score.py **rejects** any field outside this set. Don't fight the validator.

## What you DO NOT touch

- `apps/market-worker/**` — not a single line. Python lives only at `apps/market-worker/scripts/brier_bakeoff.py`; do not edit it.
- `apps/web/**`, `packages/**` — TypeScript worker + web, off-limits.
- `apps/market-worker/logs/**` — the frozen data. Don't regenerate, don't filter, don't reshuffle.
- `docs/run-ledgers/**` — append-only history.
- `.env*` — no env-var changes.
- The decision-time gate (`SECS_TO_CLOSE_GATE = 90.0` in `score.py`).
- The walk-forward cutpoints `[(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 1.00)]`.
- The executable-proxy bands `[0.20, 0.80]` (primary) and `[0.10, 0.90]` (secondary).
- The PnL `EDGE_FLOOR` and `FEE_RATE` (these are calibrated approximations of the live executor / Kalshi fee schedule).

You are tuning the **model configuration only**. Everything else is frozen.

## How to run

```bash
cd /Users/aurascoper/Developer/polyterminal
python3 autoresearch_layer2/score.py autoresearch_layer2/configs/<your_config_name>.json
```

Final line prints `SCORE: <float>` where `score` is **ΔBrier-skill** (Layer-2 model minus Gaussian baseline, in skill-vs-climatology units) on the **primary executable proxy** (`p_gaussian ∈ [0.20, 0.80]`, `secs_to_close >= 90`, all features non-null).

Full JSON result also written to `analysis/brier/autoresearch_score_<name>.json`.

## Pass condition (all six must hold on the PRIMARY executable proxy)

| Gate | Threshold | Meaning |
|---|---|---|
| `delta_skill_ge_5pp` | ΔBrier-skill ≥ 0.05 | Layer-2 model beats Gaussian-only baseline by ≥ 5 percentage points of skill, on the same rows |
| `ci_excludes_zero` | CI low > 0 | 95% paired bootstrap CI on ΔBrier-skill excludes zero |
| `retention_ok` | retention ≥ 0.80 | At least 80% of executable-proxy rows have all required features (otherwise you're scoring a self-selected subset) |
| `no_single_asset_dominance` | top-asset share ≤ 0.60 | No single asset accounts for >60% of the ΔBrier-skill |
| `no_single_fold_dominance` | top-fold share ≤ 0.50 | No single fold accounts for >50% of the ΔBrier-skill |
| `positive_net_edge` | model total_pnl > 0 | Simulated replay on the primary executable proxy: model's chosen trades clear a positive bankroll after 7% Kalshi fee on profit and the 5-cent edge floor |

The score.py returns `passes_all_gates: true/false` plus a per-flag breakdown. **A config that fails any gate is not a passing config**, even if `delta_skill` is high.

## Diagnostic outputs (NOT used for pass/fail)

- `secondary_executable_proxy` — same metric on the wider `[0.10, 0.90]` band. Useful as a sensitivity check; if primary passes but secondary doesn't, the lift is band-specific.
- `diagnostic_full_shadow` — same metric on the unfiltered shadow. If `delta_skill` here is much smaller than on primary, the lift is concentrated in marginal markets (good — that's where executable). If it's much larger, the lift is in easy markets (probably a leak or selection artifact).

## Strategy (ordered — start at the top)

1. **Confirm baseline.** Run `configs/baseline.json` (empty feature set). Expect `delta_skill = 0.0` (the model is the baseline). Confirms the harness wiring.

2. **Single-feature probes.** Run each feature alone with `raw` transform and `C=1.0`:
   - `["basis_bps"]`, transform `raw`
   - `["funding_rate"]`, transform `raw`
   - `["basis_change_bps"]`, transform `raw`
   Record which carries signal (positive `delta_skill`).

3. **Best feature × transform.** Top-1 feature from step 2, sweep transforms: `raw`, `zscore`, `winsor`.

4. **Best feature × C sweep.** With best transform, sweep `C ∈ {1e-3, 1e-2, 1e-1, 1, 1e1, 1e2}`.

5. **Pairs.** Top-2 single-feature winners combined, each with its individually best transform; re-sweep `C`.

6. **Interactions.** Only after step 5: add `[[f1, f2]]` to the best pair config. Interactions are leakage-prone — confirm `score.py:build_feature_matrix` computes the product AFTER train-fit transforms.

7. **Student-t add-on.** Toggle `include_student_t: true` on the best config from step 6, with a finer grid than the current `STUDENT_GRID` in `brier_bakeoff.py`. The Student-t branch is independent — it provides a parallel ΔBrier-skill on the primary proxy.

8. **Triple.** All three features together only if pairs are clearly insufficient.

**Stop conditions:**
- A config passes ALL six gates → run two confirmation perturbations (vary C by ±1 log step) to verify it isn't a knife-edge.
- 30 iterations elapsed with no pass → write the final report, recommend Candidate 3 next.

## What "better" looks like

The primary signal is `delta_skill` on the **primary executable proxy**. But you must ALWAYS read the pass-flags block.

A `delta_skill = 0.08` with `largest_asset_share = 0.72` is **not** a passing config — it's overfitting to BTC (or whichever single asset dominates the n in that band).

If `largest_asset_share > 0.5` repeatedly, try:
- Lowering `C` (more L2 regularization)
- Switching transform from `raw` to `winsor` (compress tails so a single asset's outliers don't drive the fit)
- Switching to `zscore` (normalize per-train-fold; reduces scale dominance)

If `delta_skill > 0` on primary but `< 0` on diagnostic_full_shadow, that's actually **fine** — it means the lift is concentrated in the marginal markets where it counts.

If `delta_skill > 0` on diagnostic_full_shadow but `≤ 0` on primary, the lift is in easy markets and useless for execution. Discard.

If `positive_net_edge` fails while `delta_skill_ge_5pp` passes, the Brier improvement isn't moving the ask-vs-fair-edge enough to clear the 5-cent floor and 7% fee. Try lowering `C` to push predictions more confidently away from 0.5.

## State tracking

Each iteration appends one JSON line to `autoresearch_layer2/state/autoresearch.jsonl`:
```json
{"type": "result", "iteration": 1, "config_name": "basis_only_raw", "delta_skill": 0.018, "ci_low": -0.002, "ci_high": 0.041, "passes_all_gates": false, "pass_flags": {...}, "status": "discard", "description": "basis_bps alone, raw, C=1.0", "timestamp": "..."}
```

Update `autoresearch_layer2/state/autoresearch_dashboard.md` after every iteration (template in launch_prompt.md).

If you lose context, re-read `autoresearch.jsonl` + dashboard to recover. Line 0 of JSONL is the experiment config header.

## Determinism

- Fixed seed `42` for bootstrap.
- LogisticRegression's `lbfgs` solver is deterministic for fixed `C` + fixed data.
- No randomness in train/test splits (fraction-based on sorted data).
- `score.py --selftest` runs the baseline three times — variance should be exactly 0.

## Things that will tempt you (do not do them)

- ❌ **Don't lower `SECS_TO_CLOSE_GATE`** to grow the universe. The 90s gate matches the live executor.
- ❌ **Don't widen the executable-proxy band beyond `[0.10, 0.90]`** (already the secondary). Doing so re-introduces the easy-market dilution.
- ❌ **Don't drop the retention floor.** A config that uses features available for 30% of trades is unusable in production.
- ❌ **Don't change the climatology baseline** (0.250).
- ❌ **Don't fit on test.** The walk-forward folds are sacred. Read `walk_forward_paired` + `fit_and_predict` to confirm transforms are TRAIN-fitted before changing anything.
- ❌ **Don't tune the PnL `EDGE_FLOOR` or `FEE_RATE`.** These are calibrated proxies of the live executor / Kalshi fee schedule.
- ❌ **Don't propose code changes to the worker** (anything under `apps/`). This loop is config-only.
- ❌ **Don't try to maximize `delta_skill` on `diagnostic_full_shadow`.** It's a diagnostic; gaming it == optimizing easy markets.

## When you find a passing config

Write the final report at `autoresearch_layer2/state/final_report.md`. Include:

1. Winning config (the JSON)
2. ΔBrier-skill + 95% CI on primary executable proxy
3. Same on secondary executable proxy
4. Per-fold and per-asset tables
5. Net edge replay summary (total PnL, win rate, n_trades, n_skips)
6. Diagnostic full-shadow comparison
7. Confirmation runs (slight C perturbations)
8. **Recommendation to the operator** — this is a research finding, not a green light. The operator decides whether R7 launches.

Do NOT write any change to `apps/`, do NOT modify env vars, do NOT touch the ledger.
