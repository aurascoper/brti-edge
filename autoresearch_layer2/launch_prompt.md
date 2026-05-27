# Launch prompt — paste into a fresh Claude Code session

```
Read /Users/aurascoper/Developer/polyterminal/autoresearch_layer2/instructions.md
and follow the experiment plan exactly. The metric is ΔBrier-skill (Layer-2
model minus Gaussian baseline) on the EXECUTABLE-PROXY universe, NOT raw
skill on the full shadow universe. Read the "Why the metric is..." section
of instructions.md first if anything is unclear.

Working directory: /Users/aurascoper/Developer/polyterminal

Procedure:
1. Read autoresearch_layer2/score.py and confirm you understand the harness:
   - load_shadow_universe + universe_filter (band + secs_to_close + feature non-null)
   - walk_forward_paired (per-fold baseline + model predictions, same rows)
   - aggregate_paired (pooled brier, paired bootstrap on ΔBrier, per-asset, per-fold)
   - simulate_net_edge (replay with PNL_EDGE_FLOOR + KALSHI_FEE_RATE)
   - score_config (3 universes: primary, secondary, diagnostic full)
   Do NOT touch score.py — only the JSON configs.

2. Run the baseline:
       python3 autoresearch_layer2/score.py autoresearch_layer2/configs/baseline.json
   Expect delta_skill ~= 0 (model IS the baseline). Record the JSON.
   Append a JSONL line to autoresearch_layer2/state/autoresearch.jsonl with
   type=baseline.

3. Run autoresearch_layer2/configs/basis_only_raw.json as iteration 1.

4. Loop, for up to 30 iterations total:
   - Read the JSONL + dashboard to recall what you've tried
   - Pick the next config according to the strategy in instructions.md
     (single-feature probes -> transforms -> C sweep -> pairs -> interactions -> student-t)
   - Write configs/iter_NN_<descriptive_name>.json
   - Run score.py, parse JSON
   - Extract: delta_skill (primary), ci_low, ci_high, passes_all_gates, pass_flags,
              net_edge.model.total_pnl, largest_asset_share, largest_fold_share,
              retention, secondary delta_skill (sensitivity)
   - Append a result line to autoresearch.jsonl
   - Regenerate autoresearch_layer2/state/autoresearch_dashboard.md
   - status="keep" if passes_all_gates AND delta_skill > current_best AND ci_low > current_best_ci_low
   - status="discard" otherwise (also when crashing: log status="crash" with the error)
   - Stop early if any config passes ALL six gates; before declaring final pass,
     run 2 confirmation perturbations (vary C by +/- 1 log step) AND confirm
     they also pass all six gates.

5. After the loop (pass found OR 30 iterations elapsed) write
   autoresearch_layer2/state/final_report.md. Include:
   - the winning config (or "no pass found"),
   - the full pass-flag block,
   - primary + secondary + diagnostic delta_skill comparison,
   - per-asset and per-fold breakdown,
   - net edge replay (n_trades, win_rate, total_pnl),
   - bootstrap CI for delta_skill,
   - recommendation: "promote to R7 readiness gate" or "no edge; try Candidate 3"

Hard rules — do not break:
- DO NOT edit apps/market-worker/scripts/brier_bakeoff.py, anything under apps/,
  anything under packages/, any log file, any env file, or any ledger file.
- DO NOT edit score.py.
- DO NOT lower SECS_TO_CLOSE_GATE below 90.
- DO NOT change the walk-forward cutpoints.
- DO NOT widen the executable-proxy bands.
- DO NOT change the climatology baseline (0.250) or PNL_EDGE_FLOOR or KALSHI_FEE_RATE.
- DO NOT add features outside ["basis_bps", "funding_rate", "basis_change_bps"].
- If a config name collides, append _v2, _v3, ... — do not overwrite prior configs.
- DO NOT optimize against diagnostic_full_shadow. It is a sanity check, not the metric.

State files you write to:
- autoresearch_layer2/configs/<name>.json (one per iteration)
- autoresearch_layer2/state/autoresearch.jsonl (append-only)
- autoresearch_layer2/state/autoresearch_dashboard.md (rewrite each iteration)
- autoresearch_layer2/state/final_report.md (at the end)

Dashboard format:
    # Autoresearch L2 Dashboard
    **Metric:** ΔBrier-skill on primary executable proxy (p ∈ [0.20, 0.80], τ ≥ 90s)
    **Baseline ΔSkill:** 0.0000 | **Current best:** Y.YY% | **Iterations:** N/30
    **Gate:** ΔSkill ≥ 5pp, CI low > 0, retention ≥ 80%, no asset >60% / no fold >50%, net edge > 0
    | # | Config | ΔSkill | CI low | CI high | Net PnL | Retention | Top asset | Top fold | Gates | Status |
    |---|--------|--------|--------|---------|---------|-----------|-----------|----------|-------|--------|
    ...
    **Kept:** K | **Discarded:** D | **Crashed:** C

If you lose context mid-loop, re-read autoresearch.jsonl + dashboard to recover.
The JSONL line 0 is the experiment config header.

Begin.
```
