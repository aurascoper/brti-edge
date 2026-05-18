// Kalshi dry-run scan loop (Phase 2.2a).
//
// What this does:
//   - polls Binance for BTC spot every 3s, computes realized σ
//   - every SCAN_INTERVAL_MS (default 5s), pulls listAllCrypto15mOpen() across all 9 series
//   - for each market, fetches orderbook + runs fairValueArbStrike
//   - appends every non-SKIP decision to logs/kalshi-candidates.jsonl
//   - appends every shadow fire (including SKIPs) to logs/kalshi-shadow.jsonl
//   - exposes a /kalshi/state HTTP endpoint (port 4001 by default)
//
// What this does NOT do (deferred):
//   - no order submission (KalshiAdapter.submitOrder still throws)
//   - no dust executor lifecycle (no candidate queue, no manual confirm)
//   - no DustPanel integration on the web side
//   - no per-asset spot feeds for non-BTC series (BTC-only execution, so BTC-only σ)
//
// Run:
//   cd apps/market-worker && pnpm run kalshi-dev
// or directly:
//   tsx src/kalshi/worker.ts

import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CRYPTO_15M_SERIES,
  isExecutionAllowed,
  KalshiAdapter,
  KalshiClient,
  type SeriesConfig,
} from "@polyterminal/kalshi-client";
import type { VenueMarketSummary, VenueOrderbook } from "@polyterminal/types";
import { fairValueArbStrike, reloadCalibration, type KalshiDecision } from "./strategy";
import { spawn } from "node:child_process";
import { SpotFeedRegistry } from "./spotFeedRegistry";
import {
  defensibilityCheck,
  KalshiDustExecutor,
  type ScannerCandidate,
} from "./dustExecutor";
import { BrtiAggregator } from "../brti/aggregator";
import type { Symbol as BrtiSymbol } from "../brti/types";
import { SettlementValidator } from "./settlementValidator";
import { PerpBasisFeed } from "./perpBasisFeed";
import { ModelBakeoffLogger } from "./modelBakeoffLogger";

// ------------------ config ------------------

loadEnvFromLiveTrading();

// Default 15s scan to stay under Kalshi's public-API rate limit (we hit 429s
// at 5s with 9 series × orderbook fetch). Override via env if needed.
const SCAN_INTERVAL_MS = numEnv("KALSHI_SCAN_INTERVAL_MS", 15_000);
const EXPIRE_POLL_MS = numEnv("KALSHI_EXPIRE_POLL_MS", 5_000);
const RECONCILE_INTERVAL_MS = numEnv("KALSHI_RECONCILE_INTERVAL_MS", 30_000);
const PORT = numEnv("KALSHI_WORKER_PORT", 4001);
const CANDIDATE_LOG = resolve(process.cwd(), "logs/kalshi-candidates.jsonl");
const SHADOW_LOG = resolve(process.cwd(), "logs/kalshi-shadow.jsonl");
const DUST_STATE_FILE = resolve(process.cwd(), "logs/kalshi-dust-state.json");
const DUST_CANDIDATES_LOG = resolve(process.cwd(), "logs/kalshi-dust-candidates.jsonl");
const SETTLEMENT_VALIDATION_LOG = resolve(process.cwd(), "logs/kalshi-settlement-validation.jsonl");
// 2Hz sampler for settlement-print validation. The settlement-window mean
// needs ≥40 of 60s of samples, which means we need an effective rate of at
// least ~0.67Hz to clear the floor. Empirically the live worker's event
// loop slows our timers from a nominal 1Hz down to ~0.5Hz under auto-submit
// + reconcile + HTTP traffic, which lands every row below 40 samples and
// trips the rejection branch. Oversampling at 500ms gives us 2x headroom
// against event-loop slip; with no slip we collect ~120 samples per window
// and the mean is more stable, with 0.5x slip we still collect ~60.
const VALIDATOR_SAMPLE_MS = 500;
// Poll for terminalized markets a bit slower than reconcile — Kalshi's result
// field can lag close_time by 60-120s, so we don't waste API calls firing
// every reconcile tick.
const VALIDATOR_FINALIZE_POLL_MS = 30_000;
// Clock-skew probe interval. Optional metadata; failures default to null.
const CLOCK_SKEW_PROBE_MS = 30_000;

// ------------------ state ------------------

interface CandidateRow {
  id: string;
  ts: string;
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
  // Source attribution — added with BRTI integration. brti when the value
  // came from the synthetic-BRTI aggregator (warm, ≥60s of 1s returns);
  // binance when it fell back to SpotFeed.
  spot_source: "brti" | "binance" | null;
  sigma_source: "brti" | "binance" | null;
  brti_contributors: string[] | null;
}

interface ShadowRow {
  ts: string;
  ticker: string;
  series: string;
  side: KalshiDecision["side"];
  fair_yes: number | null;
  edge: number | null;
  spot: number | null;
  sigma_annual: number | null;
  best_yes_bid: number | null;
  best_yes_ask: number | null;
  best_no_bid: number | null;
  best_no_ask: number | null;
  strike: number | null;
  secs_to_close: number;
  reason: string;
  spot_source: "brti" | "binance" | null;
  sigma_source: "brti" | "binance" | null;
  brti_contributors: string[] | null;
}

interface BrtiSymbolStatus {
  symbol: string;       // BTC/ETH/...
  price: number | null;
  sigma_annual: number | null;
  contributors: string[] | null;
  warm: boolean;        // both price and sigma usable from BRTI
}

interface WorkerState {
  startedAt: number;
  lastScanAt: number | null;
  totalScans: number;
  totalShadowFires: number;
  totalCandidates: number;
  candidatesByStatus: Record<string, number>;
  balance: { cash_usd: number; portfolio_value_usd: number } | null;
  spot: number | null;
  sigmaAnnual: number | null;
  // BTC headline source attribution (same source the strategy sees).
  spotSource: "brti" | "binance" | null;
  sigmaSource: "brti" | "binance" | null;
  exchangeActive: boolean | null;
  lastError: string | null;
  recentCandidates: CandidateRow[]; // ring buffer, last 50
  configuredSeries: SeriesConfig[];
  allowOrders: boolean; // mirrors ALLOW_ORDERS env; panel uses to enable/disable submit
  brti: {
    active: boolean;
    symbols: string[];
    perSymbol: BrtiSymbolStatus[];
  };
  // Optional observability metadata — null when probe disabled or last fetch
  // failed. Never let validation block on this.
  clockSkewMs: number | null;
  clockSkewLastProbeAt: number | null;
  validator: {
    tracked: number;
    finalized: number;
    rejected_for_samples: number;
  };
}

const state: WorkerState = {
  startedAt: Date.now(),
  lastScanAt: null,
  totalScans: 0,
  totalShadowFires: 0,
  totalCandidates: 0,
  candidatesByStatus: {},
  balance: null,
  spot: null,
  sigmaAnnual: null,
  spotSource: null,
  sigmaSource: null,
  exchangeActive: null,
  lastError: null,
  recentCandidates: [],
  configuredSeries: CRYPTO_15M_SERIES,
  // Initialized below after ALLOW_ORDERS is parsed
  allowOrders: false,
  brti: {
    active: false,
    symbols: [],
    perSymbol: [],
  },
  clockSkewMs: null,
  clockSkewLastProbeAt: null,
  validator: {
    tracked: 0,
    finalized: 0,
    rejected_for_samples: 0,
  },
};

// Dry-run scanner: we WANT to re-evaluate each open market on every tick
// (gives a time-series of fair_yes vs market_mid for calibration). No dedup
// in Phase 2.2a. The shadow log captures every evaluation; when the dust
// executor lifecycle is wired (Phase 2.3+), it will dedup at the candidate
// level instead.

// ------------------ adapter + feed ------------------

const client = new KalshiClient();
// Phase 2.3b: adapter-level write gate. Default OFF; flip to "1" only after
// the full lifecycle is reviewed and ready for the first real trade.
const ALLOW_ORDERS = process.env.KALSHI_ALLOW_ORDERS === "1";
state.allowOrders = ALLOW_ORDERS;
const adapter = new KalshiAdapter({ client, allowOrders: ALLOW_ORDERS });
const feeds = new SpotFeedRegistry(3_000);
const dust = new KalshiDustExecutor({
  stateFile: DUST_STATE_FILE,
  candidatesLog: DUST_CANDIDATES_LOG,
});

// Settlement-print validator. Independent of order flow — captures BRTI vs
// Binance window means and compares the implied result to Kalshi's printed
// result, without depending on any of our trades. Output is append-only
// JSONL; finalize() is idempotent so the poller can fire as often as needed.
const validator = new SettlementValidator({ outputPath: SETTLEMENT_VALIDATION_LOG });

// BRTI-first spot/σ source. Coinbase+Kraken+Bitstamp REST polling under the
// hood; getSnapshot/getSigmaAnnual return null until the per-symbol return
// buffer has ≥60s of samples, so Binance keeps serving as fallback during
// warmup and for symbols no constituent venue lists (BCH/ADA always, and
// BNB/HYPE in the current Phase-1 adapter set).
const BRTI_SYMBOLS: BrtiSymbol[] = ["BTC", "ETH", "SOL", "BNB", "DOGE", "XRP", "HYPE"];
const brti = new BrtiAggregator(BRTI_SYMBOLS);

// Spot-perp basis feed (Kraken Futures by default; PERP_FEED_REST overridable).
// First Layer-2 feature for the model-bakeoff JSONL. Polled on its own 3s
// cadence; basis is read at scan time alongside spot/sigma.
const perpFeed = new PerpBasisFeed(BRTI_SYMBOLS);

// Layer-2 shadow bakeoff log — writes one row per scored market with both
// the Gaussian/BRTI baseline prediction AND new candidate features (basis,
// later OFI). Joined with kalshi-settlement-validation.jsonl by ticker for
// prospective scoring in scripts/brier_bakeoff.py. Append-only JSONL.
const MODEL_BAKEOFF_LOG = resolve(process.cwd(), "logs/kalshi-model-bakeoff-shadow.jsonl");
const modelBakeoffLogger = new ModelBakeoffLogger({ outputPath: MODEL_BAKEOFF_LOG });

// Map Binance-style CEX ticker (KalshiSeries.cexSpotSymbol) → BRTI symbol.
// Returns null for assets BRTI doesn't track (BCH/ADA) — caller falls back.
function cexSymbolToBrti(cexSym: string): BrtiSymbol | null {
  switch (cexSym) {
    case "BTCUSDT": return "BTC";
    case "ETHUSDT": return "ETH";
    case "SOLUSDT": return "SOL";
    case "BNBUSDT": return "BNB";
    case "DOGEUSDT": return "DOGE";
    case "XRPUSDT": return "XRP";
    case "HYPEUSDT": return "HYPE";
    default: return null; // BCHUSDT, ADAUSDT — Binance only
  }
}

type SpotSource = "brti" | "binance";

interface ResolvedSpotSigma {
  spot: number | null;
  sigma: number | null;
  spot_source: SpotSource | null;
  sigma_source: SpotSource | null;
  brti_contributors: string[] | null;
}

// BRTI-first: ask the aggregator for spot + σ; for each that's null
// (warming, no venue coverage, or asset not in BRTI map), fall back to the
// Binance spot feed independently. spot and σ may come from different
// sources during a partial BRTI warmup window; we tag both fields.
function resolveSpotAndSigma(cexSym: string): ResolvedSpotSigma {
  const brtiSym = cexSymbolToBrti(cexSym);
  let spot: number | null = null;
  let sigma: number | null = null;
  let spot_source: SpotSource | null = null;
  let sigma_source: SpotSource | null = null;
  let brti_contributors: string[] | null = null;

  if (brtiSym !== null) {
    const snap = brti.getSnapshot(brtiSym);
    if (snap && Number.isFinite(snap.price) && snap.price > 0) {
      spot = snap.price;
      spot_source = "brti";
      brti_contributors = snap.contributors;
    }
    const sigmaB = brti.getSigmaAnnual(brtiSym);
    if (sigmaB !== null && Number.isFinite(sigmaB) && sigmaB > 0) {
      sigma = sigmaB;
      sigma_source = "brti";
    }
  }
  if (spot === null) {
    const s = feeds.get(cexSym).getSpot();
    if (s !== null) {
      spot = s;
      spot_source = "binance";
    }
  }
  if (sigma === null) {
    const v = feeds.get(cexSym).getSigmaAnnual();
    if (v !== null && v > 0) {
      sigma = v;
      sigma_source = "binance";
    }
  }
  return { spot, sigma, spot_source, sigma_source, brti_contributors };
}

// ------------------ scan loop ------------------

async function scan(): Promise<void> {
  state.totalScans += 1;
  state.lastScanAt = Date.now();
  state.lastError = null;

  // BTC headline spot/sigma shown in the panel (most relevant market).
  // Goes through the BRTI-first resolver so the panel reflects what the
  // strategy actually consumes for KXBTC15M.
  const btcResolved = resolveSpotAndSigma("BTCUSDT");
  state.spot = btcResolved.spot;
  state.sigmaAnnual = btcResolved.sigma;
  state.spotSource = btcResolved.spot_source;
  state.sigmaSource = btcResolved.sigma_source;

  // BRTI per-symbol diagnostics for /kalshi/state.
  state.brti.perSymbol = BRTI_SYMBOLS.map((sym) => {
    const snap = brti.getSnapshot(sym);
    const sig = brti.getSigmaAnnual(sym);
    return {
      symbol: sym,
      price: snap?.price ?? null,
      sigma_annual: sig,
      contributors: snap?.contributors ?? null,
      warm: snap !== null && sig !== null && sig > 0,
    };
  });

  // Per-series inflight gate lives in dust.evaluate(); we deliberately do NOT
  // early-return on global inflight here. Skipping the whole scan when only
  // one series is busy would prevent ETH/SOL/etc from ever getting evaluated
  // while a BTC trade is open. Kalshi public-API rate cost: ~27 orderbook
  // fetches per scan × 4 scans/min = well inside their 60-100 req/min limit.

  let markets: VenueMarketSummary[];
  try {
    markets = await adapter.listAllCrypto15mOpen(3);
  } catch (err) {
    state.lastError = `listMarkets: ${(err as Error).message}`;
    return;
  }

  for (const m of markets) {
    const seriesPrefix = m.ticker.split("-")[0]!;
    const executable = isExecutionAllowed(seriesPrefix);
    const seriesCfg = CRYPTO_15M_SERIES.find((s) => s.series === seriesPrefix);
    if (!seriesCfg) {
      // Series not in our registry — skip silently (could be a new Kalshi
      // series Kalshi added that we haven't catalogued yet).
      continue;
    }
    const resolved = resolveSpotAndSigma(seriesCfg.cexSpotSymbol);
    const spot = resolved.spot;
    const sigma = resolved.sigma;

    // Register the market with the validator (idempotent). The 1Hz sampler
    // below uses the saved opts to look up BRTI/CEX symbols per ticker.
    if (m.strike) {
      validator.track({
        ticker: m.ticker,
        series: seriesPrefix,
        strike: m.strike,
        close_time_ms: Date.parse(m.close_time),
        brti_symbol: cexSymbolToBrti(seriesCfg.cexSpotSymbol),
        cex_symbol: seriesCfg.cexSpotSymbol,
      });
    }

    // Skip strategy evaluation if feed isn't warm yet, but still emit a shadow
    // row so we can audit feed readiness across all 9 series.
    if (spot === null || sigma === null || sigma <= 0) {
      const row: ShadowRow = {
        ts: new Date().toISOString(),
        ticker: m.ticker,
        series: seriesPrefix,
        side: "SKIP",
        fair_yes: null,
        edge: null,
        spot,
        sigma_annual: sigma,
        best_yes_bid: null,
        best_yes_ask: null,
        best_no_bid: null,
        best_no_ask: null,
        strike: m.strike ?? null,
        secs_to_close: Math.max(0, (Date.parse(m.close_time) - Date.now()) / 1000),
        reason: spot === null ? "feed_no_spot" : "feed_no_sigma",
        spot_source: resolved.spot_source,
        sigma_source: resolved.sigma_source,
        brti_contributors: resolved.brti_contributors,
      };
      appendJsonl(SHADOW_LOG, row);
      state.totalShadowFires += 1;
      continue;
    }

    if (!m.strike) continue;

    let ob: VenueOrderbook;
    try {
      ob = await adapter.getOrderbook(m.ticker);
    } catch (err) {
      state.lastError = `getOrderbook(${m.ticker}): ${(err as Error).message}`;
      continue;
    }

    const closeMs = Date.parse(m.close_time);
    const decision = fairValueArbStrike({
      ticker: m.ticker,
      strike: m.strike,
      closeMs,
      nowMs: Date.now(),
      spotPrice: spot,
      sigmaAnnual: sigma,
      bestYesBid: ob.best_yes_bid,
      bestYesAsk: ob.best_yes_ask,
      bestNoBid: ob.best_no_bid,
      bestNoAsk: ob.best_no_ask,
    });

    const shadow: ShadowRow = {
      ts: new Date().toISOString(),
      ticker: m.ticker,
      series: seriesPrefix,
      side: decision.side,
      fair_yes: decision.fair_yes,
      edge: decision.edge,
      spot,
      sigma_annual: sigma,
      best_yes_bid: ob.best_yes_bid,
      best_yes_ask: ob.best_yes_ask,
      best_no_bid: ob.best_no_bid,
      best_no_ask: ob.best_no_ask,
      strike: m.strike,
      secs_to_close: Math.max(0, (closeMs - Date.now()) / 1000),
      reason: decision.reason,
      spot_source: resolved.spot_source,
      sigma_source: resolved.sigma_source,
      brti_contributors: resolved.brti_contributors,
    };
    appendJsonl(SHADOW_LOG, shadow);
    state.totalShadowFires += 1;

    // Layer-2 model-bakeoff row. Fires unconditionally — independent of
    // KALSHI_DUST_ENABLED — so shadow-mode runs accumulate prospective
    // feature/prediction pairs for scripts/brier_bakeoff.py to join with
    // settlement labels later. First feature is spot-perp basis.
    const brtiSym = cexSymbolToBrti(seriesCfg.cexSpotSymbol);
    const basis = brtiSym !== null ? perpFeed.getBasis(brtiSym, spot) : {
      basis_mid: null, basis_bps: null, perp_mark: null, perp_index: null,
      fundingRate: null, perp_age_ms: null,
    };
    modelBakeoffLogger.log({
      ts: shadow.ts,
      ticker: m.ticker,
      series: seriesPrefix,
      asset: brtiSym ?? seriesPrefix.replace("KX", "").replace("15M", ""),
      strike: m.strike,
      close_time: m.close_time,
      secs_to_close: shadow.secs_to_close,
      side_gaussian: decision.side,
      p_gaussian: decision.fair_yes,
      edge_gaussian: decision.edge,
      best_yes_bid: ob.best_yes_bid,
      best_yes_ask: ob.best_yes_ask,
      best_no_bid: ob.best_no_bid,
      best_no_ask: ob.best_no_ask,
      spot,
      spot_source: resolved.spot_source,
      sigma_annual: sigma,
      sigma_source: resolved.sigma_source,
      perp_mark: basis.perp_mark,
      perp_index: basis.perp_index,
      perp_age_ms: basis.perp_age_ms,
      basis_mid: basis.basis_mid,
      basis_bps: basis.basis_bps,
      funding_rate: basis.fundingRate,
    });

    // Save the latest decision for the validator. recordDecision() is a no-op
    // for unknown tickers, so the order with track() above doesn't matter
    // beyond this scan.
    validator.recordDecision(m.ticker, {
      fair_yes: decision.fair_yes,
      side: decision.side,
      sigma_annual: sigma,
      spot_source: resolved.spot_source,
      sigma_source: resolved.sigma_source,
    });

    if (decision.side !== "SKIP" && decision.price !== null && decision.fair_yes !== null && decision.edge !== null) {
      const cand: CandidateRow = {
        id: `kalshi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        ts: shadow.ts,
        ticker: m.ticker,
        series: seriesPrefix,
        underlying: m.underlying ?? "?",
        side: decision.side,
        ask_price: decision.price,
        fair_yes: decision.fair_yes,
        edge: decision.edge,
        strike: m.strike,
        close_time: m.close_time,
        secs_to_close: shadow.secs_to_close,
        spot,
        sigma_annual: sigma,
        best_yes_bid: ob.best_yes_bid,
        best_no_bid: ob.best_no_bid,
        spread: ob.spread,
        reason: decision.reason,
        spot_source: resolved.spot_source,
        sigma_source: resolved.sigma_source,
        brti_contributors: resolved.brti_contributors,
      };
      appendJsonl(CANDIDATE_LOG, cand);
      state.totalCandidates += 1;
      state.recentCandidates.push(cand);
      if (state.recentCandidates.length > 50) state.recentCandidates.shift();
      const tag = executable ? "[CAND-EXEC]" : "[CAND-SCAN]";
      console.log(
        `${tag} ${m.ticker} ${decision.side} @${decision.price.toFixed(3)} edge=${decision.edge.toFixed(3)} fair=${decision.fair_yes.toFixed(3)} strike=$${m.strike.toFixed(2)} spot=$${spot.toFixed(2)}`,
      );

      // Phase 2.3a: route through KalshiDustExecutor. Dedup + caps + lifecycle
      // gate. Series-execution-allowed check is inside the executor.
      const scannerCand: ScannerCandidate = {
        ts: shadow.ts,
        ticker: m.ticker,
        series: seriesPrefix,
        underlying: m.underlying ?? "?",
        side: decision.side as "YES" | "NO",
        ask_price: decision.price,
        fair_yes: decision.fair_yes,
        edge: decision.edge,
        strike: m.strike,
        close_time: m.close_time,
        secs_to_close: shadow.secs_to_close,
        spot,
        sigma_annual: sigma,
        best_yes_bid: ob.best_yes_bid,
        best_no_bid: ob.best_no_bid,
        spread: ob.spread,
        reason: decision.reason,
      };
      const res = dust.evaluate(scannerCand);
      if (res.candidate === null && res.rejectReason && res.rejectReason !== "duplicate") {
        // Log non-dedup rejections at info level so we can audit
        console.log(`[kalshi-dust] rejected ${m.ticker} ${decision.side}: ${res.rejectReason}`);
      }

      // Phase 2.5: auto-submit if candidate passes the defensibility filter.
      // All other gates (allowOrders, executionAllowed, max trades, hard stop,
      // notional, inFlightId) already enforced by evaluate() / submit().
      if (res.candidate && dust.getState().config.autoSubmit) {
        const def = defensibilityCheck(scannerCand);
        if (def.defensible) {
          const confirmRes = dust.confirm(res.candidate.id);
          if (confirmRes.ok) {
            void dust
              .submit(res.candidate.id, adapter)
              .then((r) => {
                if (r.ok) {
                  console.log(
                    `[kalshi-dust] AUTO-SUBMITTED ${m.ticker} ${decision.side} @${decision.price?.toFixed(3)} id=${res.candidate!.id}`,
                  );
                } else {
                  console.log(
                    `[kalshi-dust] auto-submit failed ${m.ticker}: ${r.reason}`,
                  );
                }
              })
              .catch((err) => {
                console.warn(
                  `[kalshi-dust] auto-submit threw ${m.ticker}:`,
                  (err as Error).message,
                );
              });
          } else {
            console.log(
              `[kalshi-dust] auto-confirm failed ${m.ticker}: ${confirmRes.reason}`,
            );
          }
        } else {
          console.log(
            `[kalshi-dust] not-defensible (manual only) ${m.ticker} ${decision.side}: ${def.reasons.join(",")}`,
          );
        }
      }
    } else {
      // Log every market evaluated so we can see scanner is alive even in flat regimes
      // Only log skip events occasionally (avoid spam in dry-run)
      if (state.totalShadowFires % 10 === 0) {
        console.log(
          `[skip] ${m.ticker} fair=${decision.fair_yes?.toFixed(3) ?? "?"} mid≈${ob.mid_yes?.toFixed(3) ?? "?"} σ=${sigma.toFixed(4)} strike=$${m.strike.toFixed(2)}`,
        );
      }
    }
  }
}

// ------------------ settlement validator helpers ------------------

// 1Hz sampler. For each tracked-and-not-finalized ticker, sample BRTI and
// Binance at the same ts_ms so the window means are computed over matched
// sample sets. Cheap — just reads cached state from the aggregators.
function sampleValidator(): void {
  const now = Date.now();
  for (const ticker of validator.getTrackedTickers()) {
    const opts = validator.getTrackOpts(ticker);
    if (!opts) continue;
    let brti_price: number | null = null;
    if (opts.brti_symbol !== null) {
      const snap = brti.getSnapshot(opts.brti_symbol as BrtiSymbol);
      if (snap && Number.isFinite(snap.price) && snap.price > 0) brti_price = snap.price;
    }
    const binance_price = feeds.get(opts.cex_symbol).getSpot();
    validator.record(now, ticker, brti_price, binance_price);
  }
}

// Finalize poller. For any tracked-not-finalized ticker whose close_time has
// passed by at least a grace period, fetch the market and call finalize()
// if the result field is populated. Idempotent so we can fire often.
async function pollFinalize(): Promise<void> {
  const now = Date.now();
  // Grace period covers Kalshi's documented result-field lag (60-120s past
  // close_time on quiet markets).
  const FINALIZE_GRACE_MS = 30_000;
  for (const ticker of validator.getTrackedTickers()) {
    if (validator.hasFinalized(ticker)) continue;
    const opts = validator.getTrackOpts(ticker);
    if (!opts) continue;
    if (now < opts.close_time_ms + FINALIZE_GRACE_MS) continue;
    try {
      const market = await adapter.getMarket(ticker);
      const result = (market?.raw as { result?: string } | undefined)?.result;
      if (result === "yes" || result === "no") {
        const row = validator.finalize(ticker, result, now, state.clockSkewMs);
        if (row) {
          state.validator.finalized += 1;
          if (row.rejected_reason) state.validator.rejected_for_samples += 1;
          console.log(
            `[settlement-validator] ${ticker} result=${result} brti_implied=${row.brti_implied_result} binance_implied=${row.binance_implied_result} brti_match=${row.brti_matches_kalshi} binance_match=${row.binance_matches_kalshi} brti_n=${row.brti_window_n} binance_n=${row.binance_window_n}${row.rejected_reason ? ` [REJECTED ${row.rejected_reason}]` : ""}`,
          );
        }
      }
    } catch {
      // Transient API failure — leave for the next poll cycle.
    }
  }
  state.validator.tracked = validator.getTrackedTickers().length;
}

// Clock-skew probe. Non-blocking observability. AbortController + small
// timeout so a stuck Kalshi endpoint can never delay the worker loop.
async function probeClockSkew(): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3_000);
  try {
    const t0 = Date.now();
    const res = await fetch("https://api.elections.kalshi.com/trade-api/v2/exchange/status", {
      method: "GET",
      signal: ac.signal,
    });
    const t1 = Date.now();
    const dateHdr = res.headers.get("date");
    if (!dateHdr) {
      state.clockSkewMs = null;
      return;
    }
    const serverMs = Date.parse(dateHdr);
    if (!Number.isFinite(serverMs)) {
      state.clockSkewMs = null;
      return;
    }
    // The Date header has 1-second resolution. Compensate by treating our
    // local time as the midpoint of the request — anything finer than
    // ±500ms is below the header's granularity and we don't claim it.
    const localMs = (t0 + t1) / 2;
    state.clockSkewMs = Math.round(localMs - serverMs);
    state.clockSkewLastProbeAt = t1;
  } catch {
    state.clockSkewMs = null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------ HTTP state endpoint ------------------

function startServer(): void {
  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,OPTIONS");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (req.url.startsWith("/health")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
        }),
      );
      return;
    }
    if (req.url.startsWith("/kalshi/state")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state));
      return;
    }
    if (req.url.startsWith("/kalshi/dust/state")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(dust.getState()));
      return;
    }
    if (req.url.startsWith("/kalshi/settlement-validator/state")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tracked: state.validator,
          markets: validator.snapshot(),
        }),
      );
      return;
    }
    const confirmMatch = req.url.match(/^\/kalshi\/dust\/confirm\/([\w-]+)$/);
    if (confirmMatch && req.method === "POST") {
      const r = dust.confirm(confirmMatch[1]!);
      res.statusCode = r.ok ? 200 : 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r));
      return;
    }
    const declineMatch = req.url.match(/^\/kalshi\/dust\/decline\/([\w-]+)$/);
    if (declineMatch && req.method === "POST") {
      const r = dust.decline(declineMatch[1]!);
      res.statusCode = r.ok ? 200 : 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r));
      return;
    }
    const submitMatch = req.url.match(/^\/kalshi\/dust\/submit\/([\w-]+)$/);
    if (submitMatch && req.method === "POST") {
      // Worker-side gate: hard-disable submit while ALLOW_ORDERS=0 even if the
      // adapter were misconfigured. Defense in depth.
      if (!ALLOW_ORDERS) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            reason: "KALSHI_ALLOW_ORDERS=0 (worker-level kill switch)",
          }),
        );
        return;
      }
      try {
        const r = await dust.submit(submitMatch[1]!, adapter);
        res.statusCode = r.ok ? 200 : 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(r));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, reason: String(err) }));
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(PORT, () => {
    console.log(`[kalshi-worker] http listening on :${PORT}`);
  });
}

// ------------------ utilities ------------------

function appendJsonl(path: string, row: unknown): void {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch (err) {
    console.warn(`[kalshi-worker] append failed (${path}):`, err);
  }
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadEnvFromLiveTrading(): void {
  if (process.env.KALSHI_API_KEY_ID) return;
  try {
    const envText = readFileSync("/Users/aurascoper/Developer/live_trading/.env", "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1]?.startsWith("KALSHI_")) {
        if (!process.env[m[1]]) process.env[m[1]] = m[2];
      }
    }
  } catch {}
}

// ------------------ main ------------------

async function refreshBalance(): Promise<void> {
  try {
    const b = await adapter.getBalance();
    state.balance = { cash_usd: b.cash_usd, portfolio_value_usd: b.portfolio_value_usd };
  } catch (err) {
    state.lastError = `getBalance: ${(err as Error).message}`;
  }
}

async function refreshExchangeStatus(): Promise<void> {
  try {
    const s = await adapter.getStatus();
    state.exchangeActive = s.exchange_active && s.trading_active;
  } catch (err) {
    state.lastError = `getStatus: ${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  console.log(`[kalshi-worker] starting; scan interval ${SCAN_INTERVAL_MS}ms; port ${PORT}`);
  console.log(
    `[kalshi-worker] configured series: ${CRYPTO_15M_SERIES.map((s) => s.series).join(", ")}`,
  );
  console.log(
    `[kalshi-worker] execution-allowed series: ${CRYPTO_15M_SERIES.filter((s) => s.executionAllowed)
      .map((s) => s.series)
      .join(", ") || "(none)"}`,
  );
  console.log(
    `[kalshi-worker] KALSHI_ALLOW_ORDERS=${ALLOW_ORDERS ? "1 (LIVE — submitOrder armed)" : "0 (worker-level kill switch ON, submit returns 403)"}`,
  );
  console.log(
    `[kalshi-worker] KALSHI_AUTO_SUBMIT=${dust.getState().config.autoSubmit ? "1 (defensible candidates auto-confirm+submit)" : "0 (manual confirm + submit required)"}`,
  );

  startServer();
  const symbols = Array.from(new Set(CRYPTO_15M_SERIES.map((s) => s.cexSpotSymbol)));
  console.log(`[kalshi-worker] preloading ${symbols.length} spot feeds: ${symbols.join(", ")}`);
  await feeds.preload(symbols);
  const snap = feeds.snapshot();
  for (const row of snap) {
    console.log(
      `[kalshi-worker]   ${row.symbol.padEnd(10)} spot=${row.spot !== null ? "$" + row.spot.toFixed(2) : "—"} age=${row.ageSec !== null ? row.ageSec.toFixed(1) + "s" : "—"}`,
    );
  }

  // BRTI aggregator: Coinbase + Kraken + Bitstamp REST polling. σ requires
  // ~60s of 1s log-returns before getSigmaAnnual() returns non-null; until
  // then the scan transparently falls back to the Binance feeds above.
  // BCH/ADA are not in BRTI_SYMBOLS and will always use the Binance fallback.
  console.log(
    `[kalshi-worker] starting BRTI aggregator for: ${BRTI_SYMBOLS.join(", ")} (~60s warmup until σ usable)`,
  );
  await brti.start();
  state.brti.active = true;
  state.brti.symbols = BRTI_SYMBOLS.slice();

  // Spot-perp basis polling (Bybit linear). Adds basis_mid / basis_bps /
  // funding_rate as candidate features for the Layer-2 bakeoff. Independent
  // of BRTI — if Bybit is unreachable the bakeoff rows just carry nulls.
  console.log(
    `[kalshi-worker] starting perp-basis feed (Kraken Futures PF_*USD) for: ${BRTI_SYMBOLS.join(", ")}`,
  );
  await perpFeed.start();

  await refreshExchangeStatus();
  await refreshBalance();
  console.log(
    `[kalshi-worker] balance: $${state.balance?.cash_usd.toFixed(2) ?? "?"}  exchange=${state.exchangeActive}`,
  );

  setInterval(refreshBalance, 30_000);
  setInterval(refreshExchangeStatus, 30_000);
  setInterval(() => {
    void scan();
  }, SCAN_INTERVAL_MS);
  setInterval(() => dust.expireStale(), EXPIRE_POLL_MS);
  setInterval(() => {
    void dust.reconcileSubmitted(adapter);
  }, RECONCILE_INTERVAL_MS);

  // Settlement-print validator: 1Hz sampler, finalize poller, clock-skew probe.
  setInterval(sampleValidator, VALIDATOR_SAMPLE_MS);
  setInterval(() => {
    void pollFinalize();
  }, VALIDATOR_FINALIZE_POLL_MS);
  // Fire one immediately so the first sample row has fresh skew metadata.
  void probeClockSkew();
  setInterval(() => {
    void probeClockSkew();
  }, CLOCK_SKEW_PROBE_MS);

  // Auto-recompute per-asset calibration from settled trades every 5 min,
  // then hot-reload the table in strategy.ts. Bias estimates improve as
  // sample grows; this keeps the model self-tuning without restart.
  const CALIBRATION_INTERVAL_MS = numEnv("KALSHI_CALIBRATION_INTERVAL_MS", 300_000);
  setInterval(() => {
    const p = spawn("python3", [resolve(process.cwd(), "scripts/compute_calibration.py")], {
      stdio: "ignore",
    });
    p.on("close", (code) => {
      if (code === 0) reloadCalibration();
    });
  }, CALIBRATION_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[kalshi-worker] fatal:", err);
  process.exit(1);
});
