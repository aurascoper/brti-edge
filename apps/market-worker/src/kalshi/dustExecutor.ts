// Kalshi dust candidate lifecycle (Phase 2.3a, dry-run only).
//
// State machine:
//   pending_confirm  (auto-created when scanner emits a non-SKIP decision)
//   → approved       (operator clicked confirm in the panel)
//   → declined       (operator clicked decline)
//   → expired        (TTL ran out without action)
//
// NOT YET:
//   - submitted / filled / canceled — wait until Phase 2.3b lands submitOrder
//   - cumulativePnl accrual         — no fills, no PnL
//
// Hard caps enforced on candidate CREATION:
//   - executionAllowed series (BTC-only at Phase 2.3a)
//   - max notional usd ($1 by default)
//   - max trades total (5)
//   - one in-flight candidate at a time (= pending_confirm or approved)
//   - daily loss stop (no-op until submit/fill lands)
//
// Persistence: state.json so worker restarts preserve in-flight + counters.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isExecutionAllowed, type KalshiAdapter } from "@polyterminal/kalshi-client";
import type { SubmitOrderResult } from "@polyterminal/types";

export type DustStatus =
  | "pending_confirm"
  | "approved"
  | "submitted"
  | "filled"
  | "canceled"
  | "declined"
  | "expired"
  | "rejected";

export interface ScannerCandidate {
  ts: string; // ISO 8601
  ticker: string;
  series: string;
  underlying: string;
  side: "YES" | "NO";
  ask_price: number;
  fair_yes: number;
  edge: number;
  strike: number;
  close_time: string;
  secs_to_close: number;
  spot: number;
  sigma_annual: number;
  best_yes_bid: number | null;
  best_no_bid: number | null;
  spread: number | null;
  reason: string;
}

export interface DustCandidate {
  id: string;
  createdAt: number; // unix ms
  expiresAt: number; // unix ms
  status: DustStatus;
  ticker: string;
  series: string;
  underlying: string;
  side: "YES" | "NO";
  ask_price: number;
  contracts: number; // sized to respect max_notional_usd
  notional_usd: number; // ask_price * contracts
  fair_yes: number;
  edge: number;
  strike: number;
  close_time: string;
  spot_at_emit: number;
  sigma_annual: number;
  best_yes_bid: number | null;
  best_no_bid: number | null;
  spread: number | null;
  reason: string;
  resolvedAt?: number; // unix ms when status left pending_confirm/approved
  // Phase 2.3b — populated on submit
  orderId?: string | null;
  submitError?: string | null;
  // Phase 2.4 — populated by reconciliation
  filled_contracts?: number; // contracts actually filled (may be < requested)
  fill_avg_price?: number; // weighted average fill price ($)
  realized_pnl_usd?: number; // computed at settlement
  reconciledAt?: number; // unix ms when status flipped to filled/canceled/rejected
}

export interface DustPolicyConfig {
  enabled: boolean;
  maxNotionalUsd: number;
  maxTradesTotal: number;
  manualConfirmFirstN: number;
  hardStopPnlUsd: number;
  candidateTtlSec: number;
  minOrderSize: number; // smallest contract count we'll quote
  // Auto-submit: when true, candidates passing the strict defensibility filter
  // get confirmed AND submitted automatically. Everything else still requires
  // manual UI action. All other gates (max trades, hard stop, inflight, series
  // execution, allowOrders) still apply.
  autoSubmit: boolean;
}

export interface DustState {
  candidates: DustCandidate[]; // append-only log; status mutates in place
  tradesSubmittedTotal: number;
  cumulativePnlUsd: number;
  inFlightId: string | null;
}

export function loadPolicyFromEnv(): DustPolicyConfig {
  const num = (k: string, d: number) => {
    const v = process.env[k];
    if (!v) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    enabled: process.env.KALSHI_DUST_ENABLED !== "0", // default ON in dry-run
    maxNotionalUsd: num("KALSHI_DUST_MAX_NOTIONAL_USD", 1),
    maxTradesTotal: num("KALSHI_DUST_MAX_TRADES", 5),
    manualConfirmFirstN: num("KALSHI_DUST_MANUAL_CONFIRM_FIRST_N", 3),
    hardStopPnlUsd: num("KALSHI_DUST_HARD_STOP_PNL_USD", -2),
    candidateTtlSec: num("KALSHI_DUST_CANDIDATE_TTL_SEC", 75),
    minOrderSize: num("KALSHI_DUST_MIN_ORDER_SIZE", 1),
    autoSubmit: process.env.KALSHI_AUTO_SUBMIT === "1",
  };
}

// ---- defensibility (Phase 2.5: auto-submit filter) ----

// Per-asset sane σ_annual ranges. These are realistic 15-min realized-vol bands
// for each underlying; outside these we don't trust the strategy's fair_yes.
// Values from observation of stable feeds across multiple market days.
// Lower bounds halved (2026-05-15) to align with SIGMA_MULTIPLIER=2.0 in the
// strategy: the raw σ floor here checks what Binance reports, while the
// fair-value model already inflates it. Upper bounds unchanged.
const SIGMA_RANGE: Record<string, [number, number]> = {
  BTC: [0.08, 1.20],
  ETH: [0.10, 1.50],
  SOL: [0.15, 2.00],
  BNB: [0.10, 1.50],
  DOGE: [0.20, 3.00],
  XRP: [0.15, 2.00],
  BCH: [0.15, 2.00],
  ADA: [0.15, 2.00],
  HYPE: [0.20, 2.50],
};

export interface DefensibilityCheck {
  defensible: boolean;
  reasons: string[]; // empty if defensible; each rejection contributes one reason
}

// "Highly defensible" filter — see project_kalshi_first_live_trade_won.md.
// Tuned to avoid the two failure modes we've actually observed:
//   (a) high-edge candidates driven by σ overcalibration (HYPE +0.41)
//   (b) thin-edge candidates that lose to trend (BTC NO -$0.81)
//
// Default thresholds err on the conservative side. Override via env if needed:
//   KALSHI_DEF_EDGE_MIN, _EDGE_MAX, _PRICE_MIN, _PRICE_MAX,
//   _SPREAD_MAX, _MIN_SECS_TO_CLOSE.
export function defensibilityCheck(c: ScannerCandidate): DefensibilityCheck {
  const reasons: string[] = [];

  // Defaults calibrated empirically 2026-05-15 against the four real candidates
  // we saw (HYPE 0.41-edge / 0.17-spread → reject; SOL/BTC/XRP defensible).
  const edgeMin = numEnv("KALSHI_DEF_EDGE_MIN", 0.02);
  const edgeMax = numEnv("KALSHI_DEF_EDGE_MAX", 0.1);
  const priceMin = numEnv("KALSHI_DEF_PRICE_MIN", 0.2);
  const priceMax = numEnv("KALSHI_DEF_PRICE_MAX", 0.8);
  const spreadMax = numEnv("KALSHI_DEF_SPREAD_MAX", 0.1);
  const minSecsToClose = numEnv("KALSHI_DEF_MIN_SECS_TO_CLOSE", 90);
  const fairMin = 0.05;
  const fairMax = 0.95;

  if (c.edge < edgeMin) reasons.push(`edge_${c.edge.toFixed(3)}_below_${edgeMin}`);
  if (c.edge > edgeMax) reasons.push(`edge_${c.edge.toFixed(3)}_above_${edgeMax}`);
  if (c.ask_price < priceMin) reasons.push(`price_${c.ask_price}_below_${priceMin}`);
  if (c.ask_price > priceMax) reasons.push(`price_${c.ask_price}_above_${priceMax}`);
  if (c.fair_yes < fairMin || c.fair_yes > fairMax) {
    reasons.push(`fair_yes_${c.fair_yes.toFixed(3)}_saturated`);
  }
  if (c.spread === null || c.spread > spreadMax) {
    reasons.push(`spread_${c.spread}_above_${spreadMax}`);
  }
  if (c.secs_to_close < minSecsToClose) {
    reasons.push(`secs_to_close_${c.secs_to_close.toFixed(0)}_below_${minSecsToClose}`);
  }

  // Per-asset σ range — extract token from underlying ("BTC-USD" → "BTC")
  const token = c.underlying.split("-")[0] ?? "";
  const range = SIGMA_RANGE[token];
  if (range) {
    const [lo, hi] = range;
    if (c.sigma_annual < lo || c.sigma_annual > hi) {
      reasons.push(`sigma_${c.sigma_annual.toFixed(3)}_outside_${token}_range_[${lo},${hi}]`);
    }
  }

  // Global σ ceiling (R2.C, 2026-05-16). Round-1 segmentation: the 15 trades
  // with σ ≥ 0.40 net-lost $3.94 (47% win rate) while the 11 trades in σ
  // 0.20-0.40 net-earned $9.14 (82% win rate). High σ inflates fair_yes
  // toward 0.5, generating large apparent edges precisely when realized
  // volatility breaks more strikes — the model misprices its own confidence.
  // Default Infinity preserves prior behaviour; set KALSHI_DEF_SIGMA_MAX=0.40
  // to enable the round-1-derived skip.
  const sigmaMax = numEnv("KALSHI_DEF_SIGMA_MAX", Infinity);
  if (c.sigma_annual >= sigmaMax) {
    reasons.push(`sigma_${c.sigma_annual.toFixed(3)}_above_global_max_${sigmaMax}`);
  }

  // YES-side asymmetric edge floor (R3.A, 2026-05-16). Across R1+R2 (n=60)
  // the YES side was 3W/6L (-$5.20) while NO was ~30W/20L (+$7.97). All YES
  // losses had σ<0.40 so the R2.C ceiling never caught them; the bias is in
  // fair_yes itself (model over-estimates P(YES) by ~5-10pp). Raising the
  // edge floor on YES only — leaving NO at the global edgeMin — directly
  // handicaps the side the data shows is mispriced. Default Infinity
  // preserves prior behaviour; set KALSHI_DEF_YES_MIN_EDGE=0.15 to enable.
  const yesMinEdge = numEnv("KALSHI_DEF_YES_MIN_EDGE", Infinity);
  if (c.side === "YES" && c.edge < yesMinEdge) {
    reasons.push(`yes_edge_${c.edge.toFixed(3)}_below_yes_min_${yesMinEdge}`);
  }

  // Contrarian-market gate (2026-05-15). The dominant loss pattern across
  // n=15 trades was: side=NO at ask ~$0.30 with edge 0.06-0.08 while market
  // priced YES at ≥0.60 (i.e., yes_bid ≥ 0.60). 4-of-5 such trades lost.
  // Fighting market consensus with small model edge is structurally −EV.
  const oppBid = c.side === "NO" ? c.best_yes_bid : c.best_no_bid;
  const contrarianThreshold = numEnv("KALSHI_DEF_CONTRARIAN_BID", 0.6);
  const contrarianEdgeMin = numEnv("KALSHI_DEF_CONTRARIAN_EDGE_MIN", 0.15);
  if (oppBid !== null && oppBid > contrarianThreshold && c.edge < contrarianEdgeMin) {
    reasons.push(
      `contrarian_${c.side}_against_${oppBid.toFixed(2)}_market_bid_edge_${c.edge.toFixed(3)}_below_${contrarianEdgeMin}`,
    );
  }

  return { defensible: reasons.length === 0, reasons };
}

function numEnv(k: string, d: number): number {
  const v = process.env[k];
  if (!v) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export interface KalshiDustExecutorOptions {
  stateFile: string;
  candidatesLog: string;
  config?: DustPolicyConfig;
}

export class KalshiDustExecutor {
  private state: DustState;
  private readonly config: DustPolicyConfig;
  private readonly stateFile: string;
  private readonly candidatesLog: string;
  // Dedup: one candidate per (ticker, side, market-close window) ever.
  // Persists across restarts via the state file (rehydrated on boot).
  private readonly seenKeys: Set<string>;

  constructor(opts: KalshiDustExecutorOptions) {
    this.config = opts.config ?? loadPolicyFromEnv();
    this.stateFile = opts.stateFile;
    this.candidatesLog = opts.candidatesLog;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.state = this.loadState();
    this.seenKeys = new Set(this.state.candidates.map(candKey));
    this.logBoot();
  }

  private logBoot(): void {
    console.log(
      `[kalshi-dust] enabled=${this.config.enabled} max_notional=$${this.config.maxNotionalUsd} ` +
        `max_trades=${this.config.maxTradesTotal} manual_first_n=${this.config.manualConfirmFirstN} ` +
        `pnl_stop=$${this.config.hardStopPnlUsd} ttl=${this.config.candidateTtlSec}s ` +
        `submitted=${this.state.tradesSubmittedTotal} cum_pnl=$${this.state.cumulativePnlUsd.toFixed(2)} ` +
        `inflight=${this.state.inFlightId ?? "none"} hydrated=${this.state.candidates.length}`,
    );
  }

  private loadState(): DustState {
    if (!existsSync(this.stateFile)) {
      return { candidates: [], tradesSubmittedTotal: 0, cumulativePnlUsd: 0, inFlightId: null };
    }
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as DustState;
    } catch {
      return { candidates: [], tradesSubmittedTotal: 0, cumulativePnlUsd: 0, inFlightId: null };
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn("[kalshi-dust] saveState failed:", err);
    }
  }

  private appendLog(c: DustCandidate): void {
    try {
      if (!existsSync(dirname(this.candidatesLog)))
        mkdirSync(dirname(this.candidatesLog), { recursive: true });
      appendFileSync(this.candidatesLog, JSON.stringify(c) + "\n");
    } catch {}
  }

  // ---- public API ----

  getState(): DustState & { config: DustPolicyConfig } {
    return { ...this.state, config: this.config };
  }

  // Called by the scan loop on every non-SKIP decision. Returns the new
  // candidate if created, or null if rejected/deduped.
  evaluate(s: ScannerCandidate): { candidate: DustCandidate | null; rejectReason?: string } {
    const key = scannerKey(s);
    if (this.seenKeys.has(key)) {
      return { candidate: null, rejectReason: "duplicate" };
    }

    // Gate checks
    if (!this.config.enabled) return { candidate: null, rejectReason: "kill_switch_disabled" };
    if (!isExecutionAllowed(s.ticker)) {
      return { candidate: null, rejectReason: "series_not_executable" };
    }
    if (this.state.tradesSubmittedTotal >= this.config.maxTradesTotal) {
      return { candidate: null, rejectReason: "max_trades_reached" };
    }
    if (this.state.cumulativePnlUsd <= this.config.hardStopPnlUsd) {
      return { candidate: null, rejectReason: "hard_stop_pnl" };
    }
    // Per-series inflight gate (2026-05-15). Single-inflight globally meant
    // BTC always grabbed the slot first (62% of candidates were KXBTC15M);
    // ETH/SOL/etc never fired. Now: one candidate at a time per series, so all
    // 9 cryptos can have parallel positions.
    if (this.isSeriesInFlight(s.series)) {
      return { candidate: null, rejectReason: `series_in_flight_${s.series}` };
    }

    // Aggregate exposure cap (2026-05-15, post-cluster-loss). 4-of-4 same-side
    // batches lost simultaneously twice tonight (−$7.52 and −$4.37). Cap total
    // $-at-risk across all inflight candidates, not just per-trade.
    const aggregateCap = numEnv("KALSHI_DUST_MAX_AGGREGATE_USD", 3);
    const currentAggregate = this.state.candidates
      .filter(
        (c) =>
          c.status === "pending_confirm" ||
          c.status === "approved" ||
          c.status === "submitted",
      )
      .reduce((sum, c) => sum + c.notional_usd, 0);
    if (currentAggregate >= aggregateCap) {
      return {
        candidate: null,
        rejectReason: `aggregate_exposure_${currentAggregate.toFixed(2)}_at_cap_${aggregateCap}`,
      };
    }

    // Same-side concurrency cap (2026-05-15). Crypto moves cluster-correlated;
    // 5 concurrent YES is one big bet, not five diversified bets. Cap N=2.
    const sameSideCap = numEnv("KALSHI_DUST_MAX_SAME_SIDE", 2);
    const sameSideCount = this.state.candidates.filter(
      (c) =>
        (c.status === "pending_confirm" ||
          c.status === "approved" ||
          c.status === "submitted") &&
        c.side === s.side,
    ).length;
    if (sameSideCount >= sameSideCap) {
      return {
        candidate: null,
        rejectReason: `same_side_${s.side}_count_${sameSideCount}_at_cap_${sameSideCap}`,
      };
    }

    // Loss-streak backoff (2026-05-15). If last N reconciled trades all lost
    // AND total recent loss >= $threshold, pause new entries for K seconds.
    // Catches regime mismatches (e.g., crypto trends down, model still betting
    // YES) without needing a drift detector.
    const streakLen = numEnv("KALSHI_DUST_BACKOFF_STREAK", 3);
    const streakLossUsd = numEnv("KALSHI_DUST_BACKOFF_LOSS_USD", 3);
    const backoffSec = numEnv("KALSHI_DUST_BACKOFF_SEC", 300);
    const recentFilled = this.state.candidates
      .filter((c) => c.status === "filled" && c.reconciledAt !== undefined)
      .sort((a, b) => (b.reconciledAt ?? 0) - (a.reconciledAt ?? 0))
      .slice(0, streakLen);
    if (recentFilled.length >= streakLen) {
      const allLost = recentFilled.every(
        (c) => (c.realized_pnl_usd ?? 0) < 0,
      );
      const totalLoss = recentFilled.reduce(
        (sum, c) => sum + Math.min(0, c.realized_pnl_usd ?? 0),
        0,
      );
      const lastReconciledAt = recentFilled[0]!.reconciledAt!;
      const sinceLast = (Date.now() - lastReconciledAt) / 1000;
      if (
        allLost &&
        Math.abs(totalLoss) >= streakLossUsd &&
        sinceLast < backoffSec
      ) {
        return {
          candidate: null,
          rejectReason: `backoff_streak_${streakLen}_loss_$${totalLoss.toFixed(2)}_age_${sinceLast.toFixed(0)}s`,
        };
      }
    }
    // Fractional Kelly sizing (2026-05-15). Replaces the prior "max out at
    // maxNotional" behavior which sized every trade the same regardless of
    // edge. Small-edge trades were a dominant loss pattern (see "contrarian
    // gate"); Kelly-shrinkage naturally drops them to zero contracts.
    //
    // Standard Kelly fraction for a binary at ask A with model win-prob p:
    //   f* = (p - A) / (1 - A) = edge / (1 - A)
    // Fractional Kelly applies a multiplier (default 0.25 = "quarter Kelly")
    // to protect against parameter uncertainty in p. Notional bankroll is an
    // env knob — the *effective* bankroll for sizing, not actual balance.
    //
    // Result still capped at maxNotionalUsd (defense-in-depth) and rejected
    // if the floor-rounded contracts < minOrderSize.
    const useKelly = process.env.KALSHI_DUST_USE_KELLY !== "0";
    let desiredContracts: number;
    if (useKelly) {
      const kellyFrac = numEnv("KALSHI_DUST_KELLY_FRACTION", 0.25);
      const bankroll = numEnv("KALSHI_DUST_KELLY_BANKROLL", 20);
      const f = s.edge > 0 ? s.edge / (1 - s.ask_price) : 0;
      const targetNotional = Math.min(
        this.config.maxNotionalUsd,
        Math.max(0, bankroll * kellyFrac * f),
      );
      desiredContracts = Math.floor(targetNotional / s.ask_price);
      if (desiredContracts < this.config.minOrderSize) {
        return {
          candidate: null,
          rejectReason: `kelly_size_${desiredContracts}_below_min_${this.config.minOrderSize}_edge_${s.edge.toFixed(3)}`,
        };
      }
    } else {
      desiredContracts = Math.max(
        this.config.minOrderSize,
        Math.floor(this.config.maxNotionalUsd / s.ask_price),
      );
    }
    const notional = desiredContracts * s.ask_price;
    if (notional > this.config.maxNotionalUsd + 1e-9) {
      return {
        candidate: null,
        rejectReason: `min_order_size_${this.config.minOrderSize}_*_price_${s.ask_price.toFixed(3)}_exceeds_cap_${this.config.maxNotionalUsd}`,
      };
    }

    const now = Date.now();
    const candidate: DustCandidate = {
      id: makeId(),
      createdAt: now,
      expiresAt: now + this.config.candidateTtlSec * 1000,
      status: "pending_confirm",
      ticker: s.ticker,
      series: s.series,
      underlying: s.underlying,
      side: s.side,
      ask_price: s.ask_price,
      contracts: desiredContracts,
      notional_usd: notional,
      fair_yes: s.fair_yes,
      edge: s.edge,
      strike: s.strike,
      close_time: s.close_time,
      spot_at_emit: s.spot,
      sigma_annual: s.sigma_annual,
      best_yes_bid: s.best_yes_bid,
      best_no_bid: s.best_no_bid,
      spread: s.spread,
      reason: s.reason,
    };

    this.state.candidates.push(candidate);
    this.state.inFlightId = candidate.id;
    this.seenKeys.add(key);
    this.saveState();
    this.appendLog(candidate);

    console.log(
      `[kalshi-dust] pending_confirm ${candidate.ticker} ${candidate.side} @${candidate.ask_price.toFixed(3)} ` +
        `sz=${candidate.contracts} notional=$${candidate.notional_usd.toFixed(2)} edge=${candidate.edge.toFixed(3)} ` +
        `id=${candidate.id}`,
    );

    // BTC-MID-NO sub-pattern watch (R4 observability, 2026-05-17). In R3 all
    // 4 BTC losses had sz=4, ask 0.47-0.58, σ 0.08-0.13. Tag matching trades
    // so R4 can validate or falsify the cohort. No execution effect.
    if (
      candidate.series === "KXBTC15M" &&
      candidate.side === "NO" &&
      candidate.contracts >= 3 &&
      candidate.ask_price >= 0.45 &&
      candidate.ask_price <= 0.60 &&
      candidate.sigma_annual >= 0.07 &&
      candidate.sigma_annual <= 0.14
    ) {
      console.log(
        `[WATCH: BTC-MID-NO] ${candidate.ticker} sz=${candidate.contracts} ask=${candidate.ask_price.toFixed(3)} ` +
          `σ=${candidate.sigma_annual.toFixed(3)} fair=${candidate.fair_yes.toFixed(3)} id=${candidate.id}`,
      );
    }

    return { candidate };
  }

  confirm(id: string): { ok: boolean; reason?: string } {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    if (c.status !== "pending_confirm")
      return { ok: false, reason: `status=${c.status}` };
    if (Date.now() > c.expiresAt) {
      c.status = "expired";
      c.resolvedAt = Date.now();
      if (this.state.inFlightId === c.id) this.state.inFlightId = null;
      this.saveState();
      return { ok: false, reason: "expired" };
    }
    c.status = "approved";
    c.resolvedAt = Date.now();
    // inFlightId stays set on c.id — submission is the next step (Phase 2.3b).
    this.saveState();
    console.log(`[kalshi-dust] approved ${c.ticker} ${c.side} id=${c.id}`);
    return { ok: true };
  }

  // Phase 2.3b: approved → submitted via the venue adapter.
  // The adapter enforces its own gates (allowOrders, series.executionAllowed,
  // type=limit, action=buy, price in [1¢,99¢]) — we re-check the dust-side
  // invariants here and surface any adapter error verbatim.
  async submit(
    id: string,
    adapter: KalshiAdapter,
  ): Promise<{ ok: boolean; reason?: string; result?: SubmitOrderResult }> {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    if (c.status !== "approved") return { ok: false, reason: `status=${c.status}` };
    if (Date.now() > c.expiresAt) {
      c.status = "expired";
      c.resolvedAt = Date.now();
      if (this.state.inFlightId === c.id) this.state.inFlightId = null;
      this.saveState();
      return { ok: false, reason: "expired" };
    }
    if (!isExecutionAllowed(c.ticker)) {
      return { ok: false, reason: "series_not_executable" };
    }
    if (this.state.tradesSubmittedTotal >= this.config.maxTradesTotal) {
      return { ok: false, reason: "max_trades_reached" };
    }
    if (this.state.cumulativePnlUsd <= this.config.hardStopPnlUsd) {
      return { ok: false, reason: "hard_stop_pnl" };
    }
    if (c.notional_usd > this.config.maxNotionalUsd + 1e-9) {
      return { ok: false, reason: "notional_exceeds_cap" };
    }
    let result: SubmitOrderResult;
    try {
      result = await adapter.submitOrder({
        ticker: c.ticker,
        side: c.side.toLowerCase() as "yes" | "no",
        action: "buy",
        type: "limit",
        count: c.contracts,
        price: c.ask_price,
        client_order_id: c.id,
      });
    } catch (err) {
      c.submitError = (err as Error).message;
      this.saveState();
      return { ok: false, reason: c.submitError };
    }
    if (!result.success) {
      // Order rejected by Kalshi; surface the message but DO NOT increment counters.
      c.submitError = result.error_message ?? "submission failed (no message)";
      this.saveState();
      console.log(`[kalshi-dust] submit rejected ${c.ticker} ${c.side} id=${c.id}: ${c.submitError}`);
      return { ok: false, reason: c.submitError, result };
    }
    c.status = "submitted";
    c.orderId = result.order_id;
    c.resolvedAt = Date.now();
    this.state.tradesSubmittedTotal += 1;
    // inFlightId stays on this candidate — it is now a live order. The lifecycle
    // continues via order-status polling (Phase 2.4) which will flip
    // submitted → filled / canceled / expired and clear inFlightId.
    this.saveState();
    console.log(
      `[kalshi-dust] submitted ${c.ticker} ${c.side} @${c.ask_price.toFixed(3)} ` +
        `count=${c.contracts} orderId=${c.orderId} id=${c.id}`,
    );
    return { ok: true, result };
  }

  decline(id: string): { ok: boolean; reason?: string } {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    if (c.status !== "pending_confirm" && c.status !== "approved")
      return { ok: false, reason: `status=${c.status}` };
    c.status = "declined";
    c.resolvedAt = Date.now();
    if (this.state.inFlightId === c.id) this.state.inFlightId = null;
    this.saveState();
    console.log(`[kalshi-dust] declined ${c.ticker} ${c.side} id=${c.id}`);
    return { ok: true };
  }

  // Phase 2.4: poll the venue for any "submitted" candidates and flip their
  // status to filled / canceled / rejected based on what Kalshi reports.
  //
  // Reconciliation logic (per submitted candidate with an orderId):
  //   1. fetch fills for the order → captures filled_contracts + fill_avg_price
  //   2. check if a position still exists for that ticker
  //      - yes → market is open, treat as filled (in-flight position)
  //      - no  → either the market settled OR we never had a fill
  //   3. for settled candidates: lookup the market's `result` field to compute
  //      realized PnL. If result matches our side, payout = filled × $1.00;
  //      else 0. realized_pnl = payout - cost.
  //
  // inFlightId is cleared as soon as the candidate reaches a terminal state
  // (filled with realized_pnl set, canceled, rejected, expired).
  // True if any candidate in series is currently pending_confirm, approved,
  // or submitted (i.e., occupying that series' inflight slot).
  private isSeriesInFlight(series: string): boolean {
    return this.state.candidates.some(
      (c) =>
        c.series === series &&
        (c.status === "pending_confirm" ||
          c.status === "approved" ||
          c.status === "submitted"),
    );
  }

  async reconcileSubmitted(adapter: KalshiAdapter): Promise<void> {
    const open = this.state.candidates.filter(
      (c) => c.status === "submitted" && (c.orderId ?? null) !== null,
    );
    if (open.length === 0) return;
    for (const c of open) {
      try {
        await this.reconcileOne(c, adapter);
      } catch (err) {
        console.warn(`[kalshi-dust] reconcile ${c.id} failed:`, (err as Error).message);
      }
    }
  }

  private async reconcileOne(c: DustCandidate, adapter: KalshiAdapter): Promise<void> {
    // 1. fetch fills for the order. Kalshi doesn't filter /portfolio/fills by
    //    order_id directly in v2; fetch a recent page and grep.
    const allFills = await adapter.listFills({ ticker: c.ticker, limit: 50 });
    const orderFills = allFills.filter((f) => f.order_id === c.orderId);
    if (orderFills.length > 0) {
      const totalCount = orderFills.reduce((sum, f) => sum + f.count, 0);
      const yes_or_no_price =
        c.side === "YES"
          ? orderFills.reduce((sum, f) => sum + f.yes_price * f.count, 0) / totalCount
          : orderFills.reduce((sum, f) => sum + f.no_price * f.count, 0) / totalCount;
      c.filled_contracts = totalCount;
      c.fill_avg_price = yes_or_no_price;
    }

    // 2. check if position still exists for this ticker
    const positions = await adapter.listPositions();
    const stillOpen = positions.some((p) => p.ticker === c.ticker);

    if (stillOpen) {
      // Market open + we hold a position. Don't terminalize yet.
      return;
    }

    // 3. No position → either market settled or order never filled.
    if (!c.filled_contracts) {
      // Never filled (e.g., canceled / expired without fill). Mark canceled,
      // clear inflight.
      c.status = "canceled";
      c.reconciledAt = Date.now();
      c.realized_pnl_usd = 0;
      if (this.state.inFlightId === c.id) this.state.inFlightId = null;
      this.saveState();
      console.log(`[kalshi-dust] reconciled ${c.id} → canceled (no fills, position cleared)`);
      return;
    }

    // We had fills but no position. Market settled OR result hasn't propagated.
    // Look up the market resolution. CRITICAL: do NOT terminalize when result
    // is empty — Kalshi's result field can lag position-clear by 60-120s, and
    // mis-terminalizing as LOST (the old default) flips wins into losses.
    let won = false;
    let resolved = false;
    try {
      const market = await adapter.getMarket(c.ticker);
      // mapMarket() returns raw = the KalshiMarket itself (not the {market:...} wrapper),
      // so result lives at raw.result directly.
      const result = (market?.raw as { result?: string } | undefined)?.result;
      if (result === "yes" || result === "no") {
        won = result.toLowerCase() === c.side.toLowerCase();
        resolved = true;
      }
    } catch {
      // Transient API failure — leave for next cycle.
    }
    if (!resolved) {
      // Wait for Kalshi to publish the binary result. Reconciler will retry.
      return;
    }

    const cost = c.filled_contracts * (c.fill_avg_price ?? c.ask_price);
    const payout = won ? c.filled_contracts * 1.0 : 0;
    const pnl = payout - cost;

    c.status = "filled";
    c.reconciledAt = Date.now();
    c.realized_pnl_usd = Math.round(pnl * 10000) / 10000;
    this.state.cumulativePnlUsd =
      Math.round((this.state.cumulativePnlUsd + pnl) * 10000) / 10000;
    if (this.state.inFlightId === c.id) this.state.inFlightId = null;
    this.saveState();
    console.log(
      `[kalshi-dust] reconciled ${c.id} → filled ${won ? "WON" : "LOST"} ` +
        `count=${c.filled_contracts} @${c.fill_avg_price?.toFixed(3)} pnl=$${pnl.toFixed(2)} cum=$${this.state.cumulativePnlUsd.toFixed(2)}`,
    );
  }

  expireStale(): void {
    const now = Date.now();
    let changed = false;
    for (const c of this.state.candidates) {
      if (
        (c.status === "pending_confirm" || c.status === "approved") &&
        now > c.expiresAt
      ) {
        c.status = "expired";
        c.resolvedAt = now;
        if (this.state.inFlightId === c.id) this.state.inFlightId = null;
        changed = true;
        console.log(`[kalshi-dust] expired ${c.ticker} ${c.side} id=${c.id}`);
      }
    }
    if (changed) this.saveState();
  }
}

function makeId(): string {
  return `kdust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Dedup key: ticker + side. One candidate per market+side over the worker's lifetime.
// The market ticker already includes close-time, so a new 15m window is a new market
// and gets its own candidate.
function candKey(c: DustCandidate): string {
  return `${c.ticker}|${c.side}`;
}
function scannerKey(s: ScannerCandidate): string {
  return `${s.ticker}|${s.side}`;
}
