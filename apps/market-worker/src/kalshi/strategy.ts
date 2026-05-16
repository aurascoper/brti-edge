// Kalshi-flavored fairValueArb.
//
// Kalshi's KXBTC15M markets are STRIKE-BASED digitals (not "up from window-start"
// like Polymarket's btc-updown-5m). For a market with floor_strike K, strike_type
// "greater_or_equal", closing at time T, with current spot S(t) and current time t:
//
//   fair_YES(t) = Φ( ln(S(t)/K) / (σ · √Δτ_years) )       (drift-free Brownian)
//
// Trade rule (binary book: bids only, asks derived via no-arb):
//   if fair_YES − best_yes_ask > halfSpread + safety + edge_floor → BUY YES at best_yes_ask
//   if fair_NO  − best_no_ask  > halfSpread + safety + edge_floor → BUY NO  at best_no_ask
//     where fair_NO = 1 − fair_YES, best_no_ask = 1 − best_yes_bid (already on the orderbook)
//   else SKIP
//
// halfSpread is computed on the YES side; it's the same on the NO side by no-arb.

const SECONDS_PER_YEAR = 365 * 24 * 3600;
const SAFETY_BUFFER = 0.005; // 50 bps cushion above market spread
const EDGE_FLOOR = 0.0075; // 75 bps minimum net edge after spread + safety

// Recalibration knobs (2026-05-15, post n=5 dust soak):
//   Binance-derived σ_annual systematically understated Kalshi 15min realized
//   vol (4-of-4 NO bets near strike lost vs model). SIGMA_MULTIPLIER inflates
//   σ before fair-value computation to dampen the model's overconfidence at
//   small |z|; MIN_Z_DISTANCE rejects coin-flip strikes outright.
function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const SIGMA_MULTIPLIER = envNum("KALSHI_SIGMA_MULTIPLIER", 1.0);
const MIN_Z_DISTANCE = envNum("KALSHI_MIN_Z_DISTANCE", 0.0);

// Per-series YES-probability bias correction (2026-05-15). Computed offline
// from settled-trade outcomes in logs/calibration.json. Loaded at module load;
// re-read via reloadCalibration() after each reconcile so live data updates it.
// Applied: fair_yes_corrected = clamp(fair_yes + alpha × bias[series], 0.05, 0.95)
//   alpha (KALSHI_CALIBRATION_ALPHA) defaults to 0.5 — apply half the observed
//   bias to be conservative against small-n estimates.
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
const CALIBRATION_PATH = resolve(process.cwd(), "logs/calibration.json");
const CALIBRATION_ALPHA = envNum("KALSHI_CALIBRATION_ALPHA", 0.5);
let calibrationBias: Record<string, number> = {};
export function reloadCalibration(): void {
  if (!existsSync(CALIBRATION_PATH)) {
    calibrationBias = {};
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")) as {
      bias_by_series?: Record<string, number>;
    };
    calibrationBias = raw.bias_by_series ?? {};
  } catch {
    calibrationBias = {};
  }
}
reloadCalibration();

export type StrategySide = "YES" | "NO" | "SKIP";

export interface KalshiStrategyInput {
  ticker: string;
  strike: number; // K — floor_strike for "above" markets
  closeMs: number; // unix ms — market close time
  nowMs: number; // unix ms — current time
  spotPrice: number; // S(t) — underlying spot (e.g., BTC from Binance)
  sigmaAnnual: number; // realized annualized vol of the underlying
  bestYesBid: number | null;
  bestYesAsk: number | null;
  bestNoBid: number | null;
  bestNoAsk: number | null;
}

export interface KalshiDecision {
  side: StrategySide;
  price: number | null; // ask price (what you'd pay)
  fair_yes: number | null;
  edge: number | null;
  reason: string;
}

export function fairValueArbStrike(input: KalshiStrategyInput): KalshiDecision {
  const { strike, closeMs, nowMs, spotPrice, sigmaAnnual, bestYesBid, bestYesAsk, bestNoAsk } =
    input;

  // Sanity gates
  if (!Number.isFinite(strike) || strike <= 0)
    return { side: "SKIP", price: null, fair_yes: null, edge: null, reason: "bad_strike" };
  if (!Number.isFinite(spotPrice) || spotPrice <= 0)
    return { side: "SKIP", price: null, fair_yes: null, edge: null, reason: "no_spot" };
  if (!Number.isFinite(sigmaAnnual) || sigmaAnnual <= 0)
    return { side: "SKIP", price: null, fair_yes: null, edge: null, reason: "no_sigma" };

  const dtSec = (closeMs - nowMs) / 1000;
  if (dtSec <= 0)
    return { side: "SKIP", price: null, fair_yes: null, edge: null, reason: "expired" };
  if (dtSec > 24 * 3600)
    return { side: "SKIP", price: null, fair_yes: null, edge: null, reason: "horizon_too_long" };

  const dtYears = dtSec / SECONDS_PER_YEAR;
  const sigmaCalibrated = sigmaAnnual * SIGMA_MULTIPLIER;
  const stdev = sigmaCalibrated * Math.sqrt(dtYears);
  if (stdev <= 0)
    return { side: "SKIP", price: null, fair_yes: null, edge: null, reason: "zero_stdev" };

  const z = Math.log(spotPrice / strike) / stdev;
  if (Math.abs(z) < MIN_Z_DISTANCE) {
    return {
      side: "SKIP",
      price: null,
      fair_yes: normalCdf(z),
      edge: null,
      reason: `coin_flip_strike |z|=${Math.abs(z).toFixed(3)} < ${MIN_Z_DISTANCE}`,
    };
  }
  const fair_yes_raw = normalCdf(z);
  // Apply per-series calibration correction. Ticker prefix is the series key
  // (e.g., "KXBTC15M-26MAY151515-15" → "KXBTC15M"). Bias is the empirical
  // (actual_yes − model_fair_yes_at_emit) on settled trades.
  const seriesKey = input.ticker.split("-")[0] ?? "";
  const bias = calibrationBias[seriesKey] ?? 0;
  const fair_yes = Math.max(0.05, Math.min(0.95, fair_yes_raw + CALIBRATION_ALPHA * bias));

  if (bestYesBid === null || bestYesAsk === null || bestNoAsk === null) {
    return {
      side: "SKIP",
      price: null,
      fair_yes,
      edge: null,
      reason: `no_book(yes_bid=${bestYesBid} yes_ask=${bestYesAsk} no_ask=${bestNoAsk})`,
    };
  }

  const halfSpread = (bestYesAsk - bestYesBid) / 2;
  const threshold = halfSpread + SAFETY_BUFFER + EDGE_FLOOR;

  const yesEdge = fair_yes - bestYesAsk;
  const fair_no = 1 - fair_yes;
  const noEdge = fair_no - bestNoAsk;

  if (yesEdge > threshold) {
    return {
      side: "YES",
      price: bestYesAsk,
      fair_yes,
      edge: yesEdge,
      reason: `fair_yes=${fair_yes.toFixed(4)} yes_ask=${bestYesAsk.toFixed(4)} edge=${yesEdge.toFixed(4)} thr=${threshold.toFixed(4)}`,
    };
  }
  if (noEdge > threshold) {
    return {
      side: "NO",
      price: bestNoAsk,
      fair_yes,
      edge: noEdge,
      reason: `fair_no=${fair_no.toFixed(4)} no_ask=${bestNoAsk.toFixed(4)} edge=${noEdge.toFixed(4)} thr=${threshold.toFixed(4)}`,
    };
  }
  return {
    side: "SKIP",
    price: null,
    fair_yes,
    edge: Math.max(yesEdge, noEdge),
    reason: `fair_yes=${fair_yes.toFixed(4)} yes_edge=${yesEdge.toFixed(4)} no_edge=${noEdge.toFixed(4)} thr=${threshold.toFixed(4)} no_edge_over_threshold`,
  };
}

// Standard-normal CDF via Abramowitz/Stegun erf approximation. Same code as
// the Polymarket fairValueArb; copied here to avoid cross-imports.
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
