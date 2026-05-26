// Queue-position model — single-quote replay simulator.
//
// Given a reconstructed book at time t and a hypothetical resting maker
// order, estimate fill timestamp, fill fraction, and post-fill markouts
// by walking forward through the historical trade tape.
//
// READ-ONLY. No live orders, no worker changes, no Brier/signal work,
// no ledger edits. This is the second primitive of the maker-execution
// replay harness, after the book reconstructor.
//
// ## Fill semantics
//
// Maker posts a resting BID on one of the two books:
//   - YES-bid at price P_y → filled by NO takers (taker_outcome_side="no")
//     at trade.yes_price_dollars == P_y
//   - NO-bid at price P_n  → filled by YES takers (taker_outcome_side="yes")
//     at trade.no_price_dollars == P_n  (equivalently trade.yes_price ==
//     1 − P_n)
//
// Each trade event is a single matched fill at one price level. A taker
// sweeping multiple levels generates multiple trade events.
//
// ## Queue progress
//
// FIFO queue. Initial queue position = function of (queue assumption,
// depth at our price level at post time):
//   - front_of_queue:        queue_ahead = 0
//   - back_of_queue:         queue_ahead = full depth at level
//   - depth_fraction(f):     queue_ahead = floor(f * depth)
//
// Each filling trade reduces queue_ahead by min(trade.count, queue_ahead).
// Any residual (trade.count − queue_ahead) eats into our_remaining_size.
// When our_remaining_size hits 0, we are fully filled.
//
// ## What v1 deliberately does NOT model
//
//   - Cancel-aware queue progress (orders ahead of us cancelling).
//     This makes the model conservative — over-estimates queue obstruction,
//     under-estimates fill rates. Safe direction for first analyses.
//   - Pro-rata fills (Kalshi is FIFO). The `depth_fraction` assumption is a
//     middle-ground for initial queue position, not a pro-rata fill rule.
//   - Our quote cancelling itself. Quote is treated as GTC until market
//     terminates (or we fill).
//   - Quote-improvement effects on taker behavior. If we post above the
//     current best, real takers might be induced to cross more aggressively;
//     we ignore this game-theoretic effect.
//   - Settlement (BRTI fix lookup). The settlement field is reserved for
//     a future external lookup. v1 leaves it null.
//
// ## What it DOES detect
//
//   - Level depleted via deltas (depth at our price hits 0 before fill) →
//     we mark the quote as abandoned because the level has migrated away;
//     a real maker would re-quote. v1 just reports "not filled".
//   - Market terminated (Shape-B snapshot) → end-of-life, partial fill
//     possible.

import { createReadStream, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import {
  applyDelta,
  applySnapshot,
  applyTerminalSnapshot,
  bestYesBid,
  bestNoBid,
  bestYesAsk,
  depthAt,
  midYes,
  newBookState,
  parseLine,
  priceToTicks,
  ticksToDollars,
  streamBookEvents,
  type BookEvent,
  type KalshiBookState,
  type Side,
} from "./bookReconstructor.js";

const MARKOUT_HORIZONS_MS = [1000, 5000, 15000, 30000, 60000] as const;

export type QueueAssumption =
  | { type: "front" }
  | { type: "back" }
  | { type: "depth_fraction"; fraction: number };

export function queueAssumptionLabel(q: QueueAssumption): string {
  switch (q.type) {
    case "front": return "front_of_queue";
    case "back": return "back_of_queue";
    case "depth_fraction": return `depth_fraction_${(q.fraction * 100).toFixed(0)}%`;
  }
}

export interface HypotheticalQuote {
  marketTicker: string;
  side: Side;            // "yes" | "no" — which book we post a BID on
  priceDollars: number;  // 0 < price < 1 in 4-decimal increments
  sizeContracts: number; // quote size (must be > 0)
  postedAtMs: number;    // server-side post timestamp (matches book event ts_ms reference frame)
  queue: QueueAssumption;
}

export interface MarkoutCents {
  ms_1000: number | null;
  ms_5000: number | null;
  ms_15000: number | null;
  ms_30000: number | null;
  ms_60000: number | null;
}

export interface QuoteSimulationResult {
  // inputs reflected back
  marketTicker: string;
  side: Side;
  priceDollars: number;
  sizeContracts: number;
  postedAtMs: number;
  queueAssumption: string;

  // initial state at post time
  initialDepthAtLevel: number;
  initialBestYesBid: number | null;
  initialBestYesAsk: number | null;
  initialMidYes: number | null;
  // distance from current best on our side, in cents
  // (>0 = improving; <0 = behind best; 0 = matching best)
  distanceFromBestCents: number | null;

  // queue progression
  queueAheadAtPost: number;
  cumulativeTradeVolumeAtLevel: number;
  numFillingTrades: number;

  // fill outcome
  filled: boolean;
  fillTsMs: number | null;
  fillFraction: number; // 0..1
  filledSize: number;

  // markouts (in cents, signed FROM MAKER PERSPECTIVE: + = maker captured)
  markoutCents: MarkoutCents;

  // diagnostic
  marketTerminated: boolean;
  levelDepleted: boolean;
  cancelledByHorizon: boolean;
  settlementYes: number | null; // null until external BRTI lookup wired in
}

// ---------- per-market event index ----------

export interface MarketIndex {
  marketTicker: string;
  trades: TradeRow[];   // sorted by tsMs ascending
  tradeTs: number[];    // parallel ts array for O(log n) binary search
  midTs: number[];      // step-function mid timeline (server ts_ms)
  midYes: number[];     // mid_yes at each ts (NaN = mid undefined)
  bookEvents: BookEvent[]; // sorted by tsMs
  bookTs: number[];     // parallel ts array
}

export interface TradeRow {
  tsMs: number;
  takerOutcomeYes: boolean;
  yesPrice: number;
  noPrice: number;
  count: number;
}


// ---------- file reading ----------

async function* readGzLines(path: string): AsyncGenerator<string> {
  const gz = createReadStream(path).pipe(createGunzip());
  gz.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "Z_BUF_ERROR" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      process.stderr.write(`[queueModel] decompress ${path}: ${err.message}\n`);
    }
  });
  const rl = createInterface({ input: gz, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "Z_BUF_ERROR" && code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
  }
}

function parseTradeLine(line: string): { marketTicker: string; row: TradeRow } | null {
  let d: any;
  try { d = JSON.parse(line); } catch { return null; }
  const m = d?.raw?.msg;
  if (!m) return null;
  const mt: string = m.market_ticker ?? "";
  if (!mt) return null;
  const yp = parseFloat(m.yes_price_dollars);
  const np = parseFloat(m.no_price_dollars);
  const ct = parseFloat(m.count_fp);
  if (!Number.isFinite(yp) || !Number.isFinite(np) || !Number.isFinite(ct)) return null;
  if (yp <= 0 || yp >= 1) return null;
  if (ct <= 0) return null;
  const tsMs: number = m.ts_ms ?? d.recv_ts_ms;
  const side: string = m.taker_outcome_side ?? "";
  if (side !== "yes" && side !== "no") return null;
  return {
    marketTicker: mt,
    row: { tsMs, takerOutcomeYes: side === "yes", yesPrice: yp, noPrice: np, count: ct },
  };
}

// Build a complete per-market index over the log dir, filtered by series.
// One pass over snapshots+deltas (for bookEvents + mid timeline), one over
// trades. Memory bounded by per-market event count — practical for the
// 30h dataset.
export async function buildMarketIndex(
  logDir: string,
  filter: (marketTicker: string) => boolean
): Promise<Map<string, MarketIndex>> {
  const idx = new Map<string, MarketIndex>();
  const ensure = (mt: string): MarketIndex => {
    let m = idx.get(mt);
    if (!m) {
      m = { marketTicker: mt, trades: [], tradeTs: [], midTs: [], midYes: [], bookEvents: [], bookTs: [] };
      idx.set(mt, m);
    }
    return m;
  };

  // Pass 1: book events + mid timeline
  const books = new Map<string, KalshiBookState>();
  for await (const ev of streamBookEvents(logDir, filter)) {
    const m = ensure(ev.marketTicker);
    m.bookEvents.push(ev);
    // also reconstruct the mid timeline inline
    let state = books.get(ev.marketTicker);
    if (!state) {
      state = newBookState(ev.marketTicker, ev.marketId);
      books.set(ev.marketTicker, state);
    }
    if (ev.type === "snapshot") applySnapshot(state, ev);
    else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
    else applyDelta(state, ev);
    const mid = midYes(state);
    const len = m.midYes.length;
    const lastTs = len > 0 ? (m.midTs[len - 1] as number) : -1;
    const lastMid = len > 0 ? (m.midYes[len - 1] as number) : Number.NaN;
    const cur = mid ?? Number.NaN;
    if (state.tsMs === lastTs) {
      // overwrite latest sample
      m.midYes[len - 1] = cur;
      continue;
    }
    const lNaN = Number.isNaN(lastMid);
    const cNaN = Number.isNaN(cur);
    if (lNaN && cNaN) continue;
    if (!lNaN && !cNaN && Math.abs(cur - lastMid) < 1e-9) continue;
    m.midTs.push(state.tsMs);
    m.midYes.push(cur);
    // extend mid timeline forward on terminal so fill-markouts at the
    // very end of life can still look up a forward mid
    if (ev.type === "snapshot_terminal" && !cNaN) {
      const extTs = state.tsMs + 60_000;
      m.midTs.push(extTs);
      m.midYes.push(cur);
    }
  }

  // Pass 2: trades
  const tradeFiles = readdirSync(logDir)
    .filter((f) => f.startsWith("trades-") && f.endsWith(".jsonl.gz"))
    .sort()
    .map((f) => resolve(logDir, f));
  for (const path of tradeFiles) {
    for await (const line of readGzLines(path)) {
      const parsed = parseTradeLine(line);
      if (!parsed) continue;
      if (!filter(parsed.marketTicker)) continue;
      ensure(parsed.marketTicker).trades.push(parsed.row);
    }
  }
  // Ensure both event lists are sorted; populate parallel ts arrays for fast lookup
  for (const m of idx.values()) {
    m.bookEvents.sort((a, b) => a.tsMs - b.tsMs);
    m.trades.sort((a, b) => a.tsMs - b.tsMs);
    m.bookTs = m.bookEvents.map((e) => e.tsMs);
    m.tradeTs = m.trades.map((t) => t.tsMs);
  }

  return idx;
}

// ---------- mid lookup (step function) ----------

function lowerBound(arr: number[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if ((arr[m] as number) <= target) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

export function midAtOrBefore(mIdx: MarketIndex, targetTs: number): number | null {
  const i = lowerBound(mIdx.midTs, targetTs);
  if (i < 0) return null;
  const v = mIdx.midYes[i] as number;
  if (Number.isNaN(v)) return null;
  // sanity: refuse mid that's older than 120s from target (safety net for
  // gaps in the book event stream; the +60s terminal extension already
  // covers normal end-of-life)
  const ts = mIdx.midTs[i] as number;
  if (targetTs - ts > 120_000) return null;
  return v;
}

// ---------- core simulation ----------

// Reconstruct the book up to post_ts, then run forward from there.
// Returns the simulation result.
//
// `cancelAfterMs` (optional): if provided, the maker cancels the resting
// quote when the next event lands at ts >= postedAtMs + cancelAfterMs.
// The result's `cancelledByHorizon` flag is set; any partial fill earned
// before the cancel still counts.
export function simulateQuote(
  quote: HypotheticalQuote,
  mIdx: MarketIndex,
  cancelAfterMs?: number
): QuoteSimulationResult {
  // 1. Rebuild book state up to (and including) postedAtMs via binary search.
  const state = newBookState(mIdx.marketTicker, "");
  const startBookIdx = lowerBound(mIdx.bookTs, quote.postedAtMs);
  let bookIdx = 0;
  // Replay book events from 0 .. startBookIdx (inclusive of the ts == postedAt
  // events; lowerBound returns last i where bookTs[i] <= postedAt).
  while (bookIdx <= startBookIdx && bookIdx < mIdx.bookEvents.length) {
    const ev = mIdx.bookEvents[bookIdx] as BookEvent;
    if (ev.type === "snapshot") applySnapshot(state, ev);
    else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
    else applyDelta(state, ev);
    bookIdx += 1;
  }

  // 2. Determine initial level depth and queue position.
  const priceStr = quote.priceDollars.toFixed(4);
  const priceTicks = priceToTicks(priceStr);
  const initialDepth = (quote.side === "yes" ? state.yesLevels : state.noLevels).get(priceTicks) ?? 0;
  const queueAhead = computeQueueAhead(quote.queue, initialDepth);

  // 3. Bookkeeping snapshot at post time.
  const initBestYesBid = bestYesBid(state);
  const initBestYesAsk = bestYesAsk(state);
  const initMid = midYes(state);

  // distance from best, in cents, signed (>0 improving above best on our side)
  let distanceFromBestCents: number | null = null;
  if (quote.side === "yes" && initBestYesBid !== null) {
    distanceFromBestCents = (quote.priceDollars - initBestYesBid) * 100;
  } else if (quote.side === "no") {
    const initBestNoBid = bestNoBid(state);
    if (initBestNoBid !== null) distanceFromBestCents = (quote.priceDollars - initBestNoBid) * 100;
  }

  // 4. Walk forward.
  //    Trades that fill us:
  //      - quote.side="yes": taker_outcome="no" AND trade.yes_price == quote.price
  //      - quote.side="no":  taker_outcome="yes" AND trade.no_price == quote.price
  //    Deltas that may deplete the level (cancels not fill-induced):
  //      apply to local levels map; if our level's depth hits 0 BEFORE we
  //      fill, mark as level-depleted.

  // First trade strictly after postedAtMs.
  let tIdx = lowerBound(mIdx.tradeTs, quote.postedAtMs) + 1;

  let mutableQueueAhead = queueAhead;
  let remaining = quote.sizeContracts;
  let cumulativeAtLevel = 0;
  let numFillingTrades = 0;
  let fillTsMs: number | null = null;
  let marketTerminated = false;
  let levelDepleted = false;
  let cancelledByHorizon = false;
  const cancelTs = cancelAfterMs !== undefined ? quote.postedAtMs + cancelAfterMs : Infinity;

  // We also track local level depth via continued delta application from the
  // post-time book state so we can detect "level disappeared".
  // bookIdx already points just past postedAtMs.

  while (bookIdx < mIdx.bookEvents.length || tIdx < mIdx.trades.length) {
    const nextBook = bookIdx < mIdx.bookEvents.length ? (mIdx.bookEvents[bookIdx] as BookEvent).tsMs : Infinity;
    const nextTrade = tIdx < mIdx.trades.length ? (mIdx.trades[tIdx] as TradeRow).tsMs : Infinity;
    const nextEventTs = Math.min(nextBook, nextTrade);
    if (nextEventTs >= cancelTs) {
      cancelledByHorizon = true;
      break;
    }

    if (nextTrade <= nextBook) {
      const t = mIdx.trades[tIdx] as TradeRow;
      tIdx += 1;
      // Does this trade fill our quote?
      const matches =
        quote.side === "yes"
          ? !t.takerOutcomeYes && priceMatch(t.yesPrice, quote.priceDollars)
          : t.takerOutcomeYes && priceMatch(t.noPrice, quote.priceDollars);
      if (!matches) continue;
      cumulativeAtLevel += t.count;
      numFillingTrades += 1;
      // FIFO consumption
      let resid = t.count;
      if (mutableQueueAhead > 0) {
        const eaten = Math.min(resid, mutableQueueAhead);
        mutableQueueAhead -= eaten;
        resid -= eaten;
      }
      if (resid > 0 && remaining > 0) {
        const filledNow = Math.min(resid, remaining);
        remaining -= filledNow;
        if (fillTsMs === null) fillTsMs = t.tsMs;
        if (remaining <= 1e-9) {
          remaining = 0;
          break;
        }
      }
      continue;
    }

    // book event before next trade
    const ev = mIdx.bookEvents[bookIdx] as BookEvent;
    bookIdx += 1;
    if (ev.type === "snapshot") applySnapshot(state, ev);
    else if (ev.type === "snapshot_terminal") { applyTerminalSnapshot(state, ev); marketTerminated = true; break; }
    else applyDelta(state, ev);
    const newDepth = (quote.side === "yes" ? state.yesLevels : state.noLevels).get(priceTicks) ?? 0;
    if (newDepth <= 1e-9) {
      // Note: this fires also when a fill exhausts the level via the trade
      // event's accompanying delta. By v1 design, we drive fill logic from
      // trades; the level-depleted abort only matters if it occurs ahead
      // of the trade for the matching fill. In practice, the trade event
      // is the one we process for filling, so by the time the delta lands
      // and triggers this branch, we may have already filled. Check first:
      if (remaining > 0 && mutableQueueAhead > 0) {
        // queue ahead of us drained without us filling — assume the level
        // migrated; a real maker would re-quote. v1 reports not-filled.
        levelDepleted = true;
        break;
      }
    }
  }

  // 5. Markouts (using mid-yes step-function timeline).
  const fillFraction = (quote.sizeContracts - remaining) / quote.sizeContracts;
  const markoutCents: MarkoutCents = {
    ms_1000: null, ms_5000: null, ms_15000: null, ms_30000: null, ms_60000: null,
  };
  if (fillTsMs !== null) {
    const midAtFill = midAtOrBefore(mIdx, fillTsMs);
    if (midAtFill !== null) {
      for (const H of MARKOUT_HORIZONS_MS) {
        const fwd = midAtOrBefore(mIdx, fillTsMs + H);
        if (fwd === null) continue;
        // Maker-side markout: maker holds the position. Posted YES-bid →
        // maker now owns YES at price `quote.priceDollars`. PnL on YES =
        // mid_fwd - quote.price. Posted NO-bid → maker owns NO at price
        // quote.price, equivalent to YES short at (1-quote.price); maker
        // PnL on YES-equivalent = (1-quote.price) - mid_fwd = -mid_fwd
        // + (1-quote.price). Unified:
        //   side=yes: markout = mid_fwd - quote.price (cents)
        //   side=no:  markout = (1 - quote.price) - mid_fwd
        const mo =
          quote.side === "yes"
            ? (fwd - quote.priceDollars) * 100
            : ((1 - quote.priceDollars) - fwd) * 100;
        switch (H) {
          case 1000: markoutCents.ms_1000 = mo; break;
          case 5000: markoutCents.ms_5000 = mo; break;
          case 15000: markoutCents.ms_15000 = mo; break;
          case 30000: markoutCents.ms_30000 = mo; break;
          case 60000: markoutCents.ms_60000 = mo; break;
        }
      }
    }
  }

  return {
    marketTicker: quote.marketTicker,
    side: quote.side,
    priceDollars: quote.priceDollars,
    sizeContracts: quote.sizeContracts,
    postedAtMs: quote.postedAtMs,
    queueAssumption: queueAssumptionLabel(quote.queue),
    initialDepthAtLevel: initialDepth,
    initialBestYesBid: initBestYesBid,
    initialBestYesAsk: initBestYesAsk,
    initialMidYes: initMid,
    distanceFromBestCents,
    queueAheadAtPost: queueAhead,
    cumulativeTradeVolumeAtLevel: cumulativeAtLevel,
    numFillingTrades,
    filled: remaining === 0,
    fillTsMs,
    fillFraction,
    filledSize: quote.sizeContracts - remaining,
    markoutCents,
    marketTerminated,
    levelDepleted,
    cancelledByHorizon,
    settlementYes: null,
  };
}

function computeQueueAhead(q: QueueAssumption, depth: number): number {
  switch (q.type) {
    case "front": return 0;
    case "back":  return depth;
    case "depth_fraction": return Math.floor(depth * q.fraction);
  }
}

// Two prices match if they round to the same 4-decimal value.
function priceMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-5;
}

// Convenience: depth at a level computed via the bookReconstructor helper.
export function levelDepth(state: KalshiBookState, side: Side, priceDollars: number): number {
  return depthAt(state, side, priceDollars.toFixed(4));
}

// Re-export so the CLI doesn't need to dance the import.
export { ticksToDollars };
