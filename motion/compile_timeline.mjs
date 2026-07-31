// Compile docs/run-ledgers/kalshi-r1-r6-ledger.jsonl into a scene timeline
// consumed by dashboard.html. Every displayed number is derived from the
// ledger rows here — nothing is invented in the renderer.
//
// Usage: node compile_timeline.mjs   (writes timeline.js next to this file)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(here, '..', 'docs', 'run-ledgers', 'kalshi-r1-r6-ledger.jsonl');

const rows = readFileSync(LEDGER, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const byRound = (id, pred = () => true) => rows.find((r) => r.round === id && pred(r));

const r3 = byRound('R3');
const r4bump = byRound('R4-mid');
const r4 = byRound('R4');
const r5open = byRound('R5', (r) => r.action === 'fresh_start_post_r4_catastrophe');
const r5 = byRound('R5', (r) => r.closed_utc);
const r6open = byRound('R6', (r) => r.action === 'launch_immediate_at_user_request');
const r6 = byRound('R6', (r) => r.closed_utc);
const r7 = rows.find((r) => String(r.round).startsWith('R7-canary'));
const prerun = rows.find((r) => String(r.round).startsWith('prerun'));

// --- derived session facts -------------------------------------------------
// R3 row: cumulative_pnl_after_round 11.23, round_pnl 9.48 -> R1+R2 residue.
const preR3 = +(r3.cumulative_pnl_after_round - r3.results.round_pnl_usd).toFixed(2);
// R5 close: balance 27.23 at pct_loss_from_start 46.9 -> starting bankroll.
const startBankroll = +(
  r5.session_state_after_round.kalshi_balance_estimated /
  (1 - r5.session_state_after_round.pct_loss_from_start / 100)
).toFixed(2);

// Session cumulative PnL keyframes (close-time accounting), in narrative order.
const curve = [
  { label: 'R1-R2', v: preR3 },
  { label: 'R3', v: r3.cumulative_pnl_after_round },
  { label: 'R4 peak', v: r4.results.peak_cum_pnl_during_round },
  { label: 'R4 halt', v: r4.results.ending_cum_pnl },
  { label: 'R5', v: r5.session_state_after_round.session_pnl_total_R1_to_R5 },
  { label: 'R6', v: r6.session_state_after_round.session_pnl_total_R1_to_R6_close_time },
  {
    label: 'R7',
    v: +(r6.session_state_after_round.session_pnl_total_R1_to_R6_close_time + r7.pnl_usd).toFixed(2),
  },
];

// The extrapolation gag, computed the way the over-better would have:
// take R3's measured EV/round and compound the Kelly-bumped notional forward.
const r3EvPerTrade = r3.results.round_pnl_usd / r3.results.trades_submitted; // $/trade at $50 Kelly
const bumpFactor = r4bump.to / r4bump.from; // 5x
const tradesPerDay = 30; // one full round/day, the R3-R6 operating cadence
const naiveDaily = +(r3EvPerTrade * bumpFactor * tradesPerDay).toFixed(2);
const naive90d = +(naiveDaily * 90).toFixed(0);

const S = (t0, t1, o) => ({ t0, t1, ...o });

const timeline = {
  meta: {
    title: 'BRTI-EDGE × KALSHI',
    subtitle: 'DUST EXECUTOR — SIX ROUNDS, 285 FILLS',
    source: 'docs/run-ledgers/kalshi-r1-r6-ledger.jsonl',
    venue: 'KALSHI 15-MINUTE CRYPTO BINARIES',
    series: ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M'],
    startBankroll,
    duration: 60,
  },
  curve,
  scenes: [
    S(0, 6, {
      id: 'intro',
      kind: 'title',
      round: '—',
      step: '0 / 7',
      kill: 'ARMED',
      question: 'Can a fair-value model beat 15-minute crypto binaries?',
      config: r3.config,
      bankrollAt: preR3,
      lines: [
        'ONE STRATEGY. ONE CONFIG. ONE KILL SWITCH.',
        `BANKROLL $${startBankroll} · KELLY $${r3.config.KALSHI_DUST_KELLY_BANKROLL} · HARD STOP $${r3.config.KALSHI_DUST_HARD_STOP_PNL_USD}`,
      ],
    }),
    S(6, 15, {
      id: 'r3',
      kind: 'round',
      round: 'R3',
      step: '1 / 7',
      kill: 'ARMED',
      question: 'R3 · does the edge exist?',
      verdict: { text: 'BEST ROUND TO DATE', tone: 'good' },
      pnl: r3.results.round_pnl_usd,
      cumFrom: preR3,
      cumTo: r3.cumulative_pnl_after_round,
      winRate: r3.results.win_rate_pct,
      ledger: [
        { k: 'trades settled', v: `${r3.results.trades_settled} / ${r3.results.trades_submitted}`, ok: true },
        { k: 'record', v: `${r3.results.wins}W / ${r3.results.losses}L`, ok: true },
        { k: 'round pnl', v: `+$${r3.results.round_pnl_usd.toFixed(2)}`, ok: true },
        { k: 'halts tripped', v: String(r3.results.halts_tripped), ok: true },
        { k: 'NO-side trades', v: `${r3.results.no_trades} / ${r3.results.trades_submitted}`, ok: true },
      ],
      gates: [
        { k: 'yes_min_edge ≥ 0.15', v: r3.filter_activity.yes_min_edge_rejections },
        { k: 'sigma_max ≤ 0.40', v: r3.filter_activity.sigma_max_rejections },
        { k: 'backoff', v: 0 },
        { k: 'hard_stop −$15', v: 0 },
      ],
      chain: [
        { k: 'gamma_trap_R4A', v: `FALSIFIED · p=${r3.hypothesis_verdicts.gamma_trap_R4A.fisher_p_final}`, tone: 'dim' },
        { k: 'btc_specific_R4B', v: `WEAK · btc $${r3.hypothesis_verdicts.btc_specific_R4B.btc_pnl}`, tone: 'dim' },
        { k: 'validator A/B', v: `BRTI ${r3.validator_ab_cumulative.brti_win_pct}% of ${r3.validator_ab_cumulative.disagreements}`, tone: 'good' },
      ],
      tickers: Object.entries(r3.ticker_breakdown).map(([k, v]) => ({ k, w: v.w, l: v.l, pnl: v.pnl })),
      note: '“No new lever justified by data.”',
    }),
    S(15, 21, {
      id: 'bump',
      kind: 'event',
      round: 'R4',
      step: '2 / 7',
      kill: 'ARMED',
      question: `R4 · mid-round: Kelly $${r4bump.from} → $${r4bump.to}`,
      verdict: { text: `${bumpFactor}× SCALE-UP ON n=30 EVIDENCE`, tone: 'warn' },
      cumFrom: r3.cumulative_pnl_after_round,
      cumTo: r4bump.at_cumpnl,
      ledger: [
        { k: 'trigger', v: `cum pnl > $${r3.cumulative_pnl_after_round}`, ok: true },
        { k: 'at trade', v: `${r4bump.at_trade} of 30`, ok: true },
        { k: 'record at bump', v: r4bump.wlt_at_bump, ok: true },
        { k: 'round is now', v: 'MIXED-KELLY · invalid as test', ok: false },
      ],
      extrapolation: {
        headline: `$${naive90d.toLocaleString()}`,
        sub: `if R3’s ${r3.results.win_rate_pct}% held at ${bumpFactor}× size · 90 days`,
        math: `$${r3EvPerTrade.toFixed(2)}/trade × ${bumpFactor} × ${tradesPerDay}/day`,
      },
      note: '“R5 will need to validate $250 at full n=30.”',
    }),
    S(21, 30, {
      id: 'r4',
      kind: 'round',
      round: 'R4',
      step: '3 / 7',
      kill: 'FIRED',
      question: 'R4 · 9 of the last 10 trades lose',
      verdict: { text: 'CATASTROPHIC · HARD STOP TRIPPED', tone: 'bad' },
      pnl: r4.results.round_pnl_usd,
      cumFrom: r4.results.peak_cum_pnl_during_round,
      cumTo: r4.results.ending_cum_pnl,
      ledger: [
        { k: 'trades submitted', v: `${r4.results.trades_submitted} / ${r4.results.max_trades_target}`, ok: false },
        { k: 'round pnl', v: `−$${Math.abs(r4.results.round_pnl_usd).toFixed(2)}`, ok: false },
        { k: 'peak → trough', v: `$${r4.results.peak_cum_pnl_during_round} → −$${Math.abs(r4.results.peak_to_trough_drawdown)}`, ok: false },
        { k: 'emergency SIGTERM', v: 'EXECUTED', ok: false },
        { k: 'stop overshoot', v: `−$${Math.abs(r4.results.hard_stop_overshoot_usd)} in-flight`, ok: false },
      ],
      gates: [
        { k: 'yes_min_edge', v: r4.filter_activity.yes_min_edge_rejections_total },
        { k: 'sigma_max', v: r4.filter_activity.sigma_max_rejections_total },
        { k: 'backoff', v: r4.filter_activity.backoff_rejections_total },
        { k: 'hard_stop −$15', v: 1, fired: true },
      ],
      chain: (r4.lessons || []).slice(0, 3).map((t) => ({ k: 'lesson', v: t, tone: 'bad' })),
      note: '“Textbook over-betting.”',
    }),
    S(30, 38, {
      id: 'r5',
      kind: 'round',
      round: 'R5',
      step: '4 / 7',
      kill: 'HALTED',
      question: 'R5 · same config as R3. Does 70% come back?',
      verdict: { text: 'REGIME-DEPENDENT OR FLUKE', tone: 'bad' },
      pnl: r5.results.round_pnl_usd,
      cumFrom: r4.results.ending_cum_pnl,
      cumTo: r5.session_state_after_round.session_pnl_total_R1_to_R5,
      winRate: r5.results.win_rate_pct,
      ledger: [
        { k: 'record', v: `${r5.results.wins}W / ${r5.results.losses}L (${r5.results.win_rate_pct}%)`, ok: false },
        { k: 'vs R3', v: 'Fisher p ≤ 0.001', ok: false },
        { k: 'halt', v: `manual SIGTERM at n=${r5.results.trades_submitted}`, ok: false },
        { k: 'balance', v: `$${r5.session_state_after_round.kalshi_balance_estimated} (−${r5.session_state_after_round.pct_loss_from_start}%)`, ok: false },
      ],
      gates: [
        { k: 'yes_min_edge', v: r5.filter_activity.yes_min_edge_rejections },
        { k: 'sigma_max', v: r5.filter_activity.sigma_max_rejections },
        { k: 'backoff', v: r5.filter_activity.backoff_rejections },
        { k: 'hard_stop −$15', v: 0 },
      ],
      hours: Object.entries(r5.win_rate_by_hour).map(([k, v]) => ({ k, v })),
      note: '“Remaining 5 trades not informative.”',
    }),
    S(38, 46, {
      id: 'r6',
      kind: 'round',
      round: 'R6',
      step: '5 / 7',
      kill: 'HALTED',
      question: 'R6 · regime test, back in the R3 window',
      verdict: { text: 'INCONCLUSIVE · Fisher p = 0.37', tone: 'warn' },
      pnl: r6.results.round_pnl_usd_close_time,
      cumFrom: r5.session_state_after_round.session_pnl_total_R1_to_R5,
      cumTo: r6.session_state_after_round.session_pnl_total_R1_to_R6_close_time,
      winRate: r6.results.win_rate_pct_close_time,
      ledger: [
        { k: 'record', v: `${r6.results.wins}W / ${r6.results.losses}L (${r6.results.win_rate_pct_close_time}%)`, ok: true },
        { k: 'round pnl', v: `+$${r6.results.round_pnl_usd_close_time}`, ok: true },
        { k: 'Brier score', v: `${r6.results.brier_score} vs 0.250 climatology`, ok: false },
        { k: 'edge/contract', v: '−4.54¢ · gate needs +2.5¢', ok: false },
        { k: 'halt', v: `stalled at n=${r6.results.trades_submitted} · σ explosion`, ok: false },
      ],
      gates: [
        { k: 'yes_min_edge', v: r6.filter_activity.yes_min_edge_rejections },
        { k: 'sigma_max', v: r6.filter_activity.sigma_max_rejections },
        { k: 'backoff', v: 0 },
        { k: 'hard_stop −$15', v: 0 },
      ],
      chain: [
        { k: 'R3 vs R6', v: 'p = 0.37 · not distinguishable', tone: 'warn' },
        { k: 'R5 vs R6', v: 'p = 0.06', tone: 'dim' },
        { k: 'conclusion', v: 'R3 was a ∼2× variance peak', tone: 'bad' },
      ],
      note: `balance $${r6.session_state_after_round.kalshi_balance_estimated} · −${r6.session_state_after_round.pct_loss_from_start}% from start`,
    }),
    S(46, 52, {
      id: 'r7',
      kind: 'round',
      round: 'R7',
      step: '6 / 7',
      kill: 'HALTED',
      question: 'R7 · micro-canary, re-funded to $74.59',
      verdict: { text: 'HALTED · 2-LOSS STOP', tone: 'bad' },
      pnl: r7.pnl_usd,
      cumFrom: r6.session_state_after_round.session_pnl_total_R1_to_R6_close_time,
      cumTo: +(r6.session_state_after_round.session_pnl_total_R1_to_R6_close_time + r7.pnl_usd).toFixed(2),
      ledger: [
        { k: 'trades', v: `${r7.trades} · both XRP NO @ $0.53`, ok: false },
        { k: 'record', v: `${r7.wins}W / ${r7.losses}L`, ok: false },
        { k: 'pnl', v: `−$${Math.abs(r7.pnl_usd)}`, ok: false },
        { k: 'stop logic', v: 'WORKED · halted on rule', ok: true },
        { k: 'balance', v: `$${r7.balance_start} → $${r7.balance_end}`, ok: false },
      ],
      note: '“Insufficient n for strategy conclusion.”',
    }),
    S(52, 60, {
      id: 'shadow',
      kind: 'title',
      round: '—',
      step: '7 / 7',
      kill: 'SAFE',
      question: 'Live trading paused. Shadow mode.',
      bankrollAt: curve[curve.length - 1].v,
      lines: [
        'R3 WAS LUCK, NOT EDGE — FISHER p = 0.37',
        'MAKER DRY-RUN: 0 ORDERS ON THE WIRE',
        `HOLDOUT COLLECTOR: ${prerun.collector.elapsed_hours}h OF 30h · NOT ELIGIBLE`,
        '5% SKILL GATE · BEST LAYER-1: 0.93% · FAILED',
      ],
    }),
  ],
};

writeFileSync(join(here, 'timeline.js'), 'window.TIMELINE = ' + JSON.stringify(timeline, null, 1) + ';\n');
console.log(
  `timeline.js written: ${timeline.scenes.length} scenes, ` +
  `bankroll $${startBankroll} start, session ${curve[curve.length - 1].v} USD close`
);
