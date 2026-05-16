// Settlement-print validator for Kalshi 15-min crypto binaries.
//
// For each tracked market, maintains a per-ticker ring buffer of (ts_ms,
// brti_price, binance_price) samples. When the worker reports that the
// market has terminalized (kalshi result is "yes" or "no"), the validator
// computes the mean of each price source over [close_time - 60s, close_time]
// — Kalshi's documented settlement window — and decides which source's
// implied outcome agrees with the actual print. Output is append-only JSONL
// at logs/kalshi-settlement-validation.jsonl. Schema is v1; expect changes.
//
// Why this is the real go/no-go:
//   - Wiring BRTI as the spot/σ source is a behavioural change to fair_yes.
//   - But edge over Binance only matters if BRTI also tracks the *settlement
//     object* better. This validator measures the latter directly, with
//     no reliance on PnL or trade outcomes.
//
// Design notes:
//   - record() takes ts_ms as a parameter (not Date.now()) so tests can
//     replay synthetic timestamps deterministically.
//   - finalize() is idempotent: repeated calls for the same ticker
//     return null after the first successful row.
//   - windowStats() is exported pure for unit testing.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SETTLEMENT_VALIDATION_SCHEMA_VERSION = 1;

// Kalshi 15-min binaries settle on a 60-second mean of the BRTI print
// immediately preceding close_time.
export const SETTLEMENT_WINDOW_MS = 60_000;

// Reject windows with fewer than this many samples (per source). The
// nominal 1Hz sampling gives 60 samples; a hard floor of 40 catches
// outages without rejecting normal jitter.
export const MIN_SAMPLES_PER_WINDOW = 40;

// Ring buffer size: hold a little more than one window's worth of 1Hz
// samples so a finalize() call that fires slightly past close_time still
// has the full window in memory.
const RING_CAPACITY = 90;

export interface SamplePoint {
  ts_ms: number;
  brti_price: number | null;
  binance_price: number | null;
}

export interface TrackOpts {
  ticker: string;
  series: string;
  strike: number;
  close_time_ms: number;
  brti_symbol: string | null; // null when BRTI doesn't cover the asset (BCH/ADA)
  cex_symbol: string;          // Binance-style symbol, e.g. BTCUSDT
}

export interface DecisionSnapshot {
  fair_yes: number | null;
  side: string | null;
  sigma_annual: number | null;
  spot_source: "brti" | "binance" | null;
  sigma_source: "brti" | "binance" | null;
}

export interface WindowStats {
  brti_mean: number | null;
  binance_mean: number | null;
  brti_n: number;
  binance_n: number;
}

export interface ValidationRow {
  schema_version: number;
  ts: string;
  ticker: string;
  series: string;
  strike: number;
  close_time: string;
  kalshi_result: string;
  brti_window_mean: number | null;
  brti_window_n: number;
  binance_window_mean: number | null;
  binance_window_n: number;
  brti_implied_result: "yes" | "no" | null;
  binance_implied_result: "yes" | "no" | null;
  brti_matches_kalshi: boolean | null;
  binance_matches_kalshi: boolean | null;
  our_fair_yes_at_decision: number | null;
  our_side_at_decision: string | null;
  sigma_at_decision: number | null;
  decision_spot_source: "brti" | "binance" | null;
  decision_sigma_source: "brti" | "binance" | null;
  clock_skew_ms: number | null;
  rejected_reason: string | null;
}

// Pure function — exported for unit testing. Computes the mean of each
// price stream over the window [close_ms - SETTLEMENT_WINDOW_MS, close_ms].
// Window is closed on both ends to include samples that land exactly on
// the boundary (Kalshi's settlement spec uses the 60s mean ending at
// close_time inclusive).
export function windowStats(samples: SamplePoint[], close_ms: number): WindowStats {
  const start = close_ms - SETTLEMENT_WINDOW_MS;
  let brti_sum = 0;
  let binance_sum = 0;
  let brti_n = 0;
  let binance_n = 0;
  for (const s of samples) {
    if (s.ts_ms < start || s.ts_ms > close_ms) continue;
    if (s.brti_price !== null && Number.isFinite(s.brti_price)) {
      brti_sum += s.brti_price;
      brti_n += 1;
    }
    if (s.binance_price !== null && Number.isFinite(s.binance_price)) {
      binance_sum += s.binance_price;
      binance_n += 1;
    }
  }
  return {
    brti_mean: brti_n > 0 ? brti_sum / brti_n : null,
    binance_mean: binance_n > 0 ? binance_sum / binance_n : null,
    brti_n,
    binance_n,
  };
}

// Pure function — exported for unit testing.
export function impliedResult(window_mean: number | null, strike: number): "yes" | "no" | null {
  if (window_mean === null) return null;
  return window_mean >= strike ? "yes" : "no";
}

interface TrackedMarket {
  opts: TrackOpts;
  ring: SamplePoint[];
  lastDecision: DecisionSnapshot;
  finalized: boolean;
}

export interface SettlementValidatorOpts {
  outputPath: string; // logs/kalshi-settlement-validation.jsonl
}

export class SettlementValidator {
  private readonly markets: Map<string, TrackedMarket> = new Map();
  private readonly outputPath: string;

  constructor(opts: SettlementValidatorOpts) {
    this.outputPath = opts.outputPath;
  }

  // Register a market for tracking. Safe to call repeatedly — only the first
  // call per ticker is effective; subsequent calls update close_time/strike
  // in case Kalshi corrected them but never reset the ring.
  track(opts: TrackOpts): void {
    const existing = this.markets.get(opts.ticker);
    if (existing) {
      existing.opts = opts;
      return;
    }
    this.markets.set(opts.ticker, {
      opts,
      ring: [],
      lastDecision: {
        fair_yes: null,
        side: null,
        sigma_annual: null,
        spot_source: null,
        sigma_source: null,
      },
      finalized: false,
    });
  }

  // Record a 1Hz sample for a ticker. ts_ms is passed (not derived from
  // Date.now()) so tests can drive synthetic timestamps.
  record(
    ts_ms: number,
    ticker: string,
    brti_price: number | null,
    binance_price: number | null,
  ): void {
    const m = this.markets.get(ticker);
    if (!m || m.finalized) return;
    m.ring.push({ ts_ms, brti_price, binance_price });
    if (m.ring.length > RING_CAPACITY) m.ring.shift();
  }

  // Record the strategy's most recent decision for a ticker. Used in the
  // validation row so we can correlate model fair_yes/side with the
  // eventual print outcome.
  recordDecision(ticker: string, d: DecisionSnapshot): void {
    const m = this.markets.get(ticker);
    if (!m || m.finalized) return;
    m.lastDecision = d;
  }

  // Idempotent: returns null on second and subsequent calls.
  finalize(
    ticker: string,
    kalshi_result: string,
    now_ms: number,
    clock_skew_ms: number | null = null,
  ): ValidationRow | null {
    const m = this.markets.get(ticker);
    if (!m || m.finalized) return null;

    const stats = windowStats(m.ring, m.opts.close_time_ms);
    let rejected_reason: string | null = null;
    if (stats.brti_n < MIN_SAMPLES_PER_WINDOW && stats.binance_n < MIN_SAMPLES_PER_WINDOW) {
      rejected_reason = `insufficient_samples brti_n=${stats.brti_n} binance_n=${stats.binance_n}`;
    }

    const brti_implied = impliedResult(stats.brti_mean, m.opts.strike);
    const binance_implied = impliedResult(stats.binance_mean, m.opts.strike);
    const brti_matches = brti_implied === null ? null : brti_implied === kalshi_result;
    const binance_matches = binance_implied === null ? null : binance_implied === kalshi_result;

    const row: ValidationRow = {
      schema_version: SETTLEMENT_VALIDATION_SCHEMA_VERSION,
      ts: new Date(now_ms).toISOString(),
      ticker: m.opts.ticker,
      series: m.opts.series,
      strike: m.opts.strike,
      close_time: new Date(m.opts.close_time_ms).toISOString(),
      kalshi_result,
      brti_window_mean: stats.brti_mean,
      brti_window_n: stats.brti_n,
      binance_window_mean: stats.binance_mean,
      binance_window_n: stats.binance_n,
      brti_implied_result: brti_implied,
      binance_implied_result: binance_implied,
      brti_matches_kalshi: brti_matches,
      binance_matches_kalshi: binance_matches,
      our_fair_yes_at_decision: m.lastDecision.fair_yes,
      our_side_at_decision: m.lastDecision.side,
      sigma_at_decision: m.lastDecision.sigma_annual,
      decision_spot_source: m.lastDecision.spot_source,
      decision_sigma_source: m.lastDecision.sigma_source,
      clock_skew_ms,
      rejected_reason,
    };

    m.finalized = true;
    this.appendJsonl(row);
    return row;
  }

  hasFinalized(ticker: string): boolean {
    return this.markets.get(ticker)?.finalized === true;
  }

  getTrackedTickers(): string[] {
    return Array.from(this.markets.keys());
  }

  getRingSize(ticker: string): number {
    return this.markets.get(ticker)?.ring.length ?? 0;
  }

  // Read-only access to track opts for a ticker — used by the worker's 1Hz
  // sampler to look up the BRTI / CEX symbol mapping without duplicating
  // state. Returns null for unknown or non-tracked tickers.
  getTrackOpts(ticker: string): TrackOpts | null {
    return this.markets.get(ticker)?.opts ?? null;
  }

  // Snapshot used by /kalshi/state for observability.
  snapshot(): Array<{
    ticker: string;
    close_time: string;
    finalized: boolean;
    ring_size: number;
  }> {
    const out: Array<{
      ticker: string;
      close_time: string;
      finalized: boolean;
      ring_size: number;
    }> = [];
    for (const m of this.markets.values()) {
      out.push({
        ticker: m.opts.ticker,
        close_time: new Date(m.opts.close_time_ms).toISOString(),
        finalized: m.finalized,
        ring_size: m.ring.length,
      });
    }
    return out;
  }

  // Drop tracking for a ticker that's been finalized (frees ring memory).
  // The finalized flag remains keyed in the map so re-tracks are no-ops.
  // For long-running workers we may want to fully evict; deferred.
  // (Not exposed yet — caller would need an explicit reason.)

  private appendJsonl(row: ValidationRow): void {
    try {
      if (!existsSync(dirname(this.outputPath))) {
        mkdirSync(dirname(this.outputPath), { recursive: true });
      }
      appendFileSync(this.outputPath, JSON.stringify(row) + "\n");
    } catch (err) {
      // Validation is observability — never let an append failure throw
      // back up into the worker loop. Log to stderr and continue.
      console.warn(`[settlement-validator] append failed:`, err);
    }
  }
}
