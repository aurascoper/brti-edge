# Launch prompt — paste into a fresh Claude Code session

```
Read /Users/aurascoper/Developer/polyterminal/autoresearch_caps/instructions.md
and follow it exactly. The metric is TOTAL REPLAY PnL across retained trades
when applying (fair_min, fair_max, edge_floor, safety_buffer) to the 287
historical filled trades in apps/market-worker/logs/kalshi-dust-state.json.
Baseline PnL = $-34.05. Pass condition needs PnL > 0 AND all five dominance
/ CI / retention gates.

Working directory: /Users/aurascoper/Developer/polyterminal

Procedure:
1. Read autoresearch_caps/score.py. Confirm you understand:
   - load_filled_trades + assign_time_folds
   - apply_config (clip + edge threshold)
   - per_asset_breakdown, per_fold_breakdown
   - bootstrap_pnl_ci
   - pass_flags logic in score_config
   Do NOT edit score.py — only the JSON configs.

2. Run the baseline:
       python3 autoresearch_caps/score.py autoresearch_caps/configs/baseline.json
   Expect PnL = -34.05, delta_pnl = 0. Append a JSONL line with type=baseline.

3. Loop, up to 30 iterations total:
   - Read JSONL + dashboard to recall what you've tried
   - Pick next config per strategy in instructions.md:
       iters 1-7:  EDGE_FLOOR sweep at fair_min=0, fair_max=1, safety=0.005
       iters 8-12: SAFETY_BUFFER sweep at best EDGE_FLOOR
       iters 13-19: FAIR_MAX sweep at best (EDGE_FLOOR, SAFETY)
       iters 20-26: FAIR_MIN sweep at best (FAIR_MAX, EDGE_FLOOR, SAFETY)
       iters 27-30: joint best + 2-3 perturbations
   - Write configs/iter_NN_<descriptive_name>.json
   - Run score.py, parse JSON
   - Extract: candidate_pnl, delta_pnl, ci_low, ci_high, n_retained,
              passes_all_gates, pass_flags, largest_asset, largest_asset_share,
              largest_fold, largest_fold_share, candidate_win_rate
   - **Be parsimonious with context.** Use jq or python3 -c to extract only
     these fields. The full JSON is on disk at analysis/brier/autoresearch_caps_<name>.json
     if you need to re-inspect.
   - Append a result line to autoresearch_caps/state/autoresearch.jsonl
   - Regenerate autoresearch_caps/state/autoresearch_dashboard.md
   - status="keep" if passes_all_gates AND candidate_pnl > current_best_pnl
   - status="discard" otherwise
   - Early stop: if a config passes ALL six gates, run 2 confirmation
     perturbations (vary one parameter by one grid step in either direction).
     Both confirmations must also pass all six gates.

4. After loop ends, write autoresearch_caps/state/final_report.md with:
   - Winning config (or "no pass found")
   - Pass-flag block
   - Replay PnL, retention, win rate
   - Per-asset + per-fold tables
   - Bootstrap CI
   - Confirmation runs
   - Recommendation: "promote to R7 strategy constants" or "no robust positive
     subset; further work needed (more shadow data, or different lever)"

Hard rules:
- DO NOT edit anything under apps/, packages/, docs/run-ledgers/, .env*, score.py.
- DO NOT touch autoresearch_layer2/ (sibling experiment, not part of this run).
- If a config name collides, append _v2, _v3.
- DO NOT optimize against per-fold dominance by changing the fold count.

Dashboard format:
    # Autoresearch Caps Dashboard
    **Metric:** Replay PnL across retained trades (baseline -$34.05)
    **Current best:** $X.XX | **Iterations:** N/30
    **Gates:** PnL>0, CI low>0, n_retained>=50, no asset>60%, no fold>50%, delta_pnl>0
    | # | Config | PnL | Δ | n_kept | CI low | Top asset | Top fold | Gates | Status |
    |---|--------|-----|---|--------|--------|-----------|----------|-------|--------|
    ...

If context lost, re-read autoresearch.jsonl + dashboard. Line 0 = header.

Begin.
```
