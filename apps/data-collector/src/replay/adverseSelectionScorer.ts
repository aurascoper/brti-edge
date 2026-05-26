// Adverse-selection EV scorer for BTC_TOUCH_DEPTH50.
//
// Decomposes the per-filled-quote settlement PnL into three components:
//
//   1. Spread captured at fill
//        YES-bid: (mid_at_fill − quote_price)
//        NO-bid:  ((1 − mid_at_fill) − quote_price)
//      This is the half-spread the maker earns on the in-the-touch posting.
//
//   2. Short-horizon adverse selection (signed)
//        YES-bid: (mid_at_fill+H − mid_at_fill)
//        NO-bid:  (mid_at_fill − mid_at_fill+H)
//      Reported at H ∈ {1s, 5s, 15s, 30s, 60s}. Negative means the market
//      moved against the maker after fill (information leak).
//
//   3. Residual drift to settlement (signed)
//        YES-bid: (settlement_yes − mid_at_fill+60s)
//        NO-bid:  (mid_at_fill+60s − settlement_yes)
//      This is whatever doesn't get captured in the 60s window.
//
// Identity (per filled quote, both sides):
//   settlement_PnL = spread_captured + adverse_selection_60s + residual
//
// We verify this identity holds within floating-point tolerance per quote.
//
// Aggregations:
//   - TTE bucket           (5: 0-3, 3-6, 6-9, 9-12, 12-15 min into life)
//   - Time-of-day bucket   (6: 4-hour UTC blocks)
//   - Side                 (yes-bid, no-bid)
//   - Queue assumption     (front_of_queue, depth_fraction_50%, back_of_queue)
//   - Fill latency bucket  (5: <1s, 1-5s, 5-30s, 30-300s, 300s+)
//   - Moneyness bucket     (3: |price−0.5| < 0.15 / 0.15-0.30 / ≥0.30)
//
// Pass criteria (for going forward to the BTC maker replay):
//
//   1. Settlement EV does NOT come from one TTE bucket — at least 2 TTE
//      buckets must individually have positive settlement EV.
//   2. Settlement EV does NOT come from one side — both YES-bid and NO-bid
//      aggregate EV must be positive.
//   3. Adverse selection is bounded AND recoverable — |adv_sel_60s| ≤ 2¢
//      AND residual ≥ |adv_sel_60s| (settlement drift recovers the cost).
//   4. Leave-best-bucket-out — removing the strongest single TTE bucket
//      still leaves overall settlement EV > 0.
//
// READ-ONLY. No live orders, no worker changes, no ledger edits,
// no Brier/signal model work.
//
// Run:
//   pnpm exec tsx src/replay/adverseSelectionScorer.ts

import { resolve } from "node:path";
import {
  applyDelta,
  applySnapshot,
  applyTerminalSnapshot,
  bestYesBid,
  bestNoBid,
  newBookState,
} from "./bookReconstructor.js";
import {
  buildMarketIndex,
  midAtOrBefore,
  simulateQuote,
  type HypotheticalQuote,
  type MarketIndex,
  type QueueAssumption,
} from "./queueModel.js";

const SERIES = "KXBTC15M";
const QUEUE_VARIANTS: QueueAssumption[] = [
  { type: "front" },
  { type: "depth_fraction", fraction: 0.5 },
  { type: "back" },
];
const PRIMARY_QUEUE_LABEL = "depth_fraction_50%";
const ANCHOR_PERIOD_MS = 60_000;
const ANCHOR_RUNWAY_MS = 60_000;

const ADV_SEL_HORIZONS_MS = [1000, 5000, 15000, 30000, 60000] as const;
type AdvSelHorizon = typeof ADV_SEL_HORIZONS_MS[number];

const TTE_BUCKETS = ["0-3min", "3-6min", "6-9min", "9-12min", "12-15min"] as const;
type TteBucket = typeof TTE_BUCKETS[number];

const FILL_LATENCY_BUCKETS = ["<1s", "1-5s", "5-30s", "30-300s", "300s+"] as const;
type FillLatencyBucket = typeof FILL_LATENCY_BUCKETS[number];

const MONEYNESS_BUCKETS = ["near_50 (<0.15)", "lean (0.15-0.30)", "deep (≥0.30)"] as const;
type MoneynessBucket = typeof MONEYNESS_BUCKETS[number];

interface Args { logDir: string }
function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return { logDir: args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector") };
}

function isBtcMarket(mt: string): boolean { return mt.startsWith(SERIES + "-"); }

// ---------- settlement inference (same as passive simulator) ----------

interface SettlementLabel {
  value: number | null;
  confidence: "high" | "low" | "none";
}

function inferSettlement(midTs: number[], midYes: number[], lastTradeTs: number, lastTradeYesPrice: number): SettlementLabel {
  const lastMidIdx = midYes.length - 1;
  const lastMidTs = lastMidIdx >= 0 ? (midTs[lastMidIdx] as number) : -1;
  const lastMid = lastMidIdx >= 0 ? (midYes[lastMidIdx] as number) : Number.NaN;
  let v: number;
  if (lastTradeTs > lastMidTs && Number.isFinite(lastTradeYesPrice)) v = lastTradeYesPrice;
  else if (!Number.isNaN(lastMid)) v = lastMid;
  else return { value: null, confidence: "none" };
  if (v >= 0.97) return { value: 1.0, confidence: "high" };
  if (v <= 0.03) return { value: 0.0, confidence: "high" };
  return { value: v, confidence: "low" };
}

// ---------- bucketing ----------

function tteBucket(tteMs: number): TteBucket {
  const mins = tteMs / 60_000;
  if (mins < 3) return "0-3min";
  if (mins < 6) return "3-6min";
  if (mins < 9) return "6-9min";
  if (mins < 12) return "9-12min";
  return "12-15min";
}

function todBucket(anchorTsMs: number): string {
  const h = new Date(anchorTsMs).getUTCHours();
  const block = Math.floor(h / 4);
  const start = block * 4;
  const end = start + 4;
  return `${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}Z`;
}

function fillLatencyBucket(latMs: number): FillLatencyBucket {
  if (latMs < 1_000) return "<1s";
  if (latMs < 5_000) return "1-5s";
  if (latMs < 30_000) return "5-30s";
  if (latMs < 300_000) return "30-300s";
  return "300s+";
}

function moneynessBucket(priceDollars: number, side: "yes" | "no"): MoneynessBucket {
  // Convert to YES-mid equivalent for consistent moneyness measure.
  // YES-bid at price P → YES-mid ≈ P (we paid YES at price P at the touch)
  // NO-bid at price P → YES-mid ≈ 1 - P
  const yesEquivalent = side === "yes" ? priceDollars : (1 - priceDollars);
  const dist = Math.abs(yesEquivalent - 0.5);
  if (dist < 0.15) return "near_50 (<0.15)";
  if (dist < 0.30) return "lean (0.15-0.30)";
  return "deep (≥0.30)";
}

// ---------- per-quote decomposition ----------

interface DecomposedQuote {
  marketTicker: string;
  side: "yes" | "no";
  price: number;
  queueAssumption: string;
  filled: boolean;
  fillTsMs: number | null;
  fillLatencyMs: number | null;
  tteAtPostMs: number;
  midAtFill: number | null; // YES-mid at fill ts
  midAtFillPlus: Partial<Record<AdvSelHorizon, number | null>>; // YES-mid at fill+H
  settlement: SettlementLabel;
  // decomposition in CENTS (signed; positive favors maker)
  spreadCapturedCents: number | null;
  adverseSelectionCents: Partial<Record<AdvSelHorizon, number | null>>;
  residualToSettlementCents: number | null;
  settlementPnlCents: number | null;
  // bucket assignments
  tteBucketStr: TteBucket;
  todBucketStr: string;
  fillLatencyBucketStr: FillLatencyBucket | null;
  moneynessBucketStr: MoneynessBucket;
  // identity verification
  identityResidualCents: number | null; // settlement_PnL - (spread + adv60s + residual) — should ≈ 0
}

function makeDecomposed(
  m: MarketIndex,
  side: "yes" | "no",
  quotePrice: number,
  queueLabel: string,
  fillTsMs: number | null,
  filled: boolean,
  postedAtMs: number,
  tteMs: number,
  settlement: SettlementLabel
): DecomposedQuote {
  const fillLatencyMs = fillTsMs !== null ? fillTsMs - postedAtMs : null;
  const tte = tteBucket(tteMs);
  const tod = todBucket(postedAtMs);
  const moneyness = moneynessBucket(quotePrice, side);
  const fillLatBucket = fillLatencyMs !== null ? fillLatencyBucket(fillLatencyMs) : null;

  const dq: DecomposedQuote = {
    marketTicker: m.marketTicker,
    side,
    price: quotePrice,
    queueAssumption: queueLabel,
    filled,
    fillTsMs,
    fillLatencyMs,
    tteAtPostMs: tteMs,
    midAtFill: null,
    midAtFillPlus: {},
    settlement,
    spreadCapturedCents: null,
    adverseSelectionCents: {},
    residualToSettlementCents: null,
    settlementPnlCents: null,
    tteBucketStr: tte,
    todBucketStr: tod,
    fillLatencyBucketStr: fillLatBucket,
    moneynessBucketStr: moneyness,
    identityResidualCents: null,
  };

  if (!filled || fillTsMs === null) return dq;

  // Look up mid at fill time AND at fill + H for each horizon.
  const midAtFill = midAtOrBefore(m, fillTsMs);
  dq.midAtFill = midAtFill;
  for (const H of ADV_SEL_HORIZONS_MS) {
    dq.midAtFillPlus[H] = midAtOrBefore(m, fillTsMs + H);
  }

  if (midAtFill === null) return dq; // can't compute decomposition

  // Spread captured (cents).
  if (side === "yes") {
    dq.spreadCapturedCents = (midAtFill - quotePrice) * 100;
  } else {
    dq.spreadCapturedCents = ((1 - midAtFill) - quotePrice) * 100;
  }

  // Adverse selection at each horizon.
  for (const H of ADV_SEL_HORIZONS_MS) {
    const m_h = dq.midAtFillPlus[H];
    if (m_h === null || m_h === undefined) {
      dq.adverseSelectionCents[H] = null;
      continue;
    }
    if (side === "yes") {
      dq.adverseSelectionCents[H] = (m_h - midAtFill) * 100;
    } else {
      dq.adverseSelectionCents[H] = (midAtFill - m_h) * 100;
    }
  }

  // Residual drift to settlement + total settlement PnL.
  if (settlement.value !== null) {
    const m60 = dq.midAtFillPlus[60000];
    if (m60 !== null && m60 !== undefined) {
      if (side === "yes") {
        dq.residualToSettlementCents = (settlement.value - m60) * 100;
        dq.settlementPnlCents = (settlement.value - quotePrice) * 100;
      } else {
        dq.residualToSettlementCents = (m60 - settlement.value) * 100;
        dq.settlementPnlCents = ((1 - settlement.value) - quotePrice) * 100;
      }
      // identity: total = spread + adv60 + residual
      const adv60 = dq.adverseSelectionCents[60000];
      if (adv60 !== null && adv60 !== undefined && dq.spreadCapturedCents !== null) {
        const sum = dq.spreadCapturedCents + adv60 + dq.residualToSettlementCents;
        dq.identityResidualCents = dq.settlementPnlCents - sum;
      }
    }
  }

  return dq;
}

// ---------- aggregation ----------

interface ComponentStats {
  n: number;
  spreadSum: number;
  spreadN: number;
  advSelSums: Map<AdvSelHorizon, { sum: number; n: number }>;
  residualSum: number;
  residualN: number;
  settlementSum: number;
  settlementN: number;
  identityMaxAbs: number;
}

function newStats(): ComponentStats {
  const advSelSums = new Map<AdvSelHorizon, { sum: number; n: number }>();
  for (const H of ADV_SEL_HORIZONS_MS) advSelSums.set(H, { sum: 0, n: 0 });
  return {
    n: 0, spreadSum: 0, spreadN: 0,
    advSelSums,
    residualSum: 0, residualN: 0,
    settlementSum: 0, settlementN: 0,
    identityMaxAbs: 0,
  };
}

function addToStats(s: ComponentStats, dq: DecomposedQuote): void {
  s.n += 1;
  if (dq.spreadCapturedCents !== null) { s.spreadSum += dq.spreadCapturedCents; s.spreadN += 1; }
  for (const H of ADV_SEL_HORIZONS_MS) {
    const v = dq.adverseSelectionCents[H];
    if (v === null || v === undefined) continue;
    const agg = s.advSelSums.get(H)!;
    agg.sum += v;
    agg.n += 1;
  }
  if (dq.residualToSettlementCents !== null) { s.residualSum += dq.residualToSettlementCents; s.residualN += 1; }
  if (dq.settlementPnlCents !== null) { s.settlementSum += dq.settlementPnlCents; s.settlementN += 1; }
  if (dq.identityResidualCents !== null) {
    const a = Math.abs(dq.identityResidualCents);
    if (a > s.identityMaxAbs) s.identityMaxAbs = a;
  }
}

function mean(sum: number, n: number): number {
  return n > 0 ? sum / n : Number.NaN;
}

function fmt(x: number): string {
  return Number.isNaN(x) ? "—" : (x >= 0 ? "+" : "") + x.toFixed(3);
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  process.stderr.write(`[adverseSelectionScorer] log dir: ${args.logDir}\n`);

  const t0 = Date.now();
  process.stderr.write(`[adverseSelectionScorer] building BTC market index...\n`);
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(`[adverseSelectionScorer] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Settlement labels.
  const settlements = new Map<string, SettlementLabel>();
  for (const [mt, m] of idx.entries()) {
    const lastTrade = m.trades[m.trades.length - 1];
    settlements.set(mt, inferSettlement(
      m.midTs, m.midYes,
      lastTrade ? lastTrade.tsMs : -1,
      lastTrade ? lastTrade.yesPrice : Number.NaN
    ));
  }

  // Simulate at every-60s anchors, both sides, all 3 queue assumptions, to-expiry.
  const decomposed: DecomposedQuote[] = [];
  let simCount = 0;
  const tSim = Date.now();
  for (const m of idx.values()) {
    if (m.bookEvents.length < 10) continue;
    const first = m.bookEvents[0]!.tsMs;
    const last = m.bookEvents[m.bookEvents.length - 1]!.tsMs;
    if (last - first < 2 * ANCHOR_PERIOD_MS) continue;
    const lastAnchor = last - ANCHOR_RUNWAY_MS;
    const settlement = settlements.get(m.marketTicker)!;
    for (let anchorTs = first + ANCHOR_PERIOD_MS; anchorTs <= lastAnchor; anchorTs += ANCHOR_PERIOD_MS) {
      const state = newBookState(m.marketTicker, "");
      for (const ev of m.bookEvents) {
        if (ev.tsMs > anchorTs) break;
        if (ev.type === "snapshot") applySnapshot(state, ev);
        else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
        else applyDelta(state, ev);
      }
      const yb = bestYesBid(state);
      const nb = bestNoBid(state);
      if (yb === null || nb === null) continue;
      const tteMs = last - anchorTs;

      for (const queue of QUEUE_VARIANTS) {
        const queueLabel = (() => {
          switch (queue.type) {
            case "front": return "front_of_queue";
            case "back": return "back_of_queue";
            case "depth_fraction": return `depth_fraction_${(queue.fraction * 100).toFixed(0)}%`;
          }
        })();
        for (const sp of [{ side: "yes" as const, price: yb }, { side: "no" as const, price: nb }]) {
          const quote: HypotheticalQuote = {
            marketTicker: m.marketTicker, side: sp.side, priceDollars: sp.price,
            sizeContracts: 1, postedAtMs: anchorTs, queue,
          };
          const r = simulateQuote(quote, m);
          simCount += 1;
          const dq = makeDecomposed(m, sp.side, sp.price, queueLabel, r.fillTsMs, r.filled, anchorTs, tteMs, settlement);
          decomposed.push(dq);
        }
      }
    }
  }
  process.stderr.write(`[adverseSelectionScorer] simulated ${simCount.toLocaleString()} quotes in ${((Date.now() - tSim) / 1000).toFixed(1)}s\n`);

  // Identity verification.
  const withIdentity = decomposed.filter((d) => d.identityResidualCents !== null);
  const maxAbsResidual = withIdentity.reduce((a, d) => Math.max(a, Math.abs(d.identityResidualCents!)), 0);
  process.stderr.write(`[adverseSelectionScorer] identity check: ${withIdentity.length} quotes verified, max |residual| = ${maxAbsResidual.toExponential(2)}¢\n`);

  // ---------- reports ----------
  console.log();
  console.log("# Adverse-selection scorer — BTC_TOUCH_DEPTH50");
  console.log();
  console.log(`- Simulated ${simCount.toLocaleString()} quotes across ${idx.size} BTC markets`);
  console.log(`- Identity check: max |(spread + adv60 + residual) − settlement_PnL| = ${maxAbsResidual.toExponential(2)}¢ across ${withIdentity.length} quotes`);
  console.log();
  console.log("All component means below are CONDITIONAL on a fill (with settlement label and 60s markout available).");
  console.log();

  // Primary: depth_50, filled, with settlement.
  const primary = decomposed.filter((d) => d.queueAssumption === PRIMARY_QUEUE_LABEL && d.filled && d.settlementPnlCents !== null);

  // (A) Overall component breakdown for depth_50 filled quotes.
  console.log("## A. Decomposition (depth_50, filled+settled)");
  console.log();
  console.log("| component | mean (¢/filled) |");
  console.log("|---|---:|");
  const spreadMean = mean(primary.reduce((s, d) => s + (d.spreadCapturedCents ?? 0), 0), primary.filter((d) => d.spreadCapturedCents !== null).length);
  const resMean = mean(primary.reduce((s, d) => s + (d.residualToSettlementCents ?? 0), 0), primary.filter((d) => d.residualToSettlementCents !== null).length);
  const settleMean = mean(primary.reduce((s, d) => s + (d.settlementPnlCents ?? 0), 0), primary.length);
  console.log(`| spread captured | ${fmt(spreadMean)} |`);
  for (const H of ADV_SEL_HORIZONS_MS) {
    const samples = primary.map((d) => d.adverseSelectionCents[H]).filter((v): v is number => v !== null && v !== undefined);
    const mu = mean(samples.reduce((a, b) => a + b, 0), samples.length);
    console.log(`| adv selection @ ${H / 1000}s | ${fmt(mu)} |`);
  }
  console.log(`| residual (60s → settlement) | ${fmt(resMean)} |`);
  console.log(`| **settlement PnL (= spread + adv60 + residual)** | **${fmt(settleMean)}** |`);
  console.log();

  // (B) By TTE bucket.
  console.log("## B. By TTE bucket");
  console.log();
  console.log("| bucket | n filled | spread (¢) | adv60 (¢) | residual (¢) | settlement (¢/filled) | settlement (¢/posted) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  // posted = depth_50 all anchors per bucket
  const postedByTte = new Map<TteBucket, number>();
  for (const d of decomposed) if (d.queueAssumption === PRIMARY_QUEUE_LABEL) postedByTte.set(d.tteBucketStr, (postedByTte.get(d.tteBucketStr) ?? 0) + 1);
  for (const b of TTE_BUCKETS) {
    const sub = primary.filter((d) => d.tteBucketStr === b);
    const posted = postedByTte.get(b) ?? 0;
    if (sub.length === 0) { console.log(`| ${b} | 0 | — | — | — | — | — |`); continue; }
    const sp = mean(sub.reduce((a, d) => a + (d.spreadCapturedCents ?? 0), 0), sub.length);
    const a60 = mean(sub.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined).reduce((a, b) => a + b, 0), sub.filter((d) => d.adverseSelectionCents[60000] !== null && d.adverseSelectionCents[60000] !== undefined).length);
    const re = mean(sub.reduce((a, d) => a + (d.residualToSettlementCents ?? 0), 0), sub.length);
    const stF = mean(sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0), sub.length);
    const stP = posted > 0 ? (sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0) / posted) : NaN;
    console.log(`| ${b} | ${sub.length.toLocaleString()} | ${fmt(sp)} | ${fmt(a60)} | ${fmt(re)} | ${fmt(stF)} | ${fmt(stP)} |`);
  }
  console.log();

  // (C) By side.
  console.log("## C. By side");
  console.log();
  console.log("| side | n filled | spread (¢) | adv60 (¢) | residual (¢) | settlement (¢/filled) | settlement (¢/posted) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const side of ["yes", "no"] as const) {
    const sub = primary.filter((d) => d.side === side);
    const posted = decomposed.filter((d) => d.queueAssumption === PRIMARY_QUEUE_LABEL && d.side === side).length;
    if (sub.length === 0) { console.log(`| ${side} | 0 | — | — | — | — | — |`); continue; }
    const sp = mean(sub.reduce((a, d) => a + (d.spreadCapturedCents ?? 0), 0), sub.length);
    const a60Samples = sub.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined);
    const a60 = mean(a60Samples.reduce((a, b) => a + b, 0), a60Samples.length);
    const re = mean(sub.reduce((a, d) => a + (d.residualToSettlementCents ?? 0), 0), sub.length);
    const stF = mean(sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0), sub.length);
    const stP = posted > 0 ? (sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0) / posted) : NaN;
    console.log(`| ${side}-bid | ${sub.length.toLocaleString()} | ${fmt(sp)} | ${fmt(a60)} | ${fmt(re)} | ${fmt(stF)} | ${fmt(stP)} |`);
  }
  console.log();

  // (D) By queue assumption.
  console.log("## D. By queue assumption (filled-only)");
  console.log();
  console.log("| queue | n filled | spread (¢) | adv60 (¢) | residual (¢) | settlement (¢/filled) | settlement (¢/posted) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const queue of QUEUE_VARIANTS) {
    const qLabel = (() => {
      switch (queue.type) {
        case "front": return "front_of_queue";
        case "back": return "back_of_queue";
        case "depth_fraction": return `depth_fraction_${(queue.fraction * 100).toFixed(0)}%`;
      }
    })();
    const all = decomposed.filter((d) => d.queueAssumption === qLabel);
    const sub = all.filter((d) => d.filled && d.settlementPnlCents !== null);
    const posted = all.length;
    if (sub.length === 0) { console.log(`| ${qLabel} | 0 | — | — | — | — | — |`); continue; }
    const sp = mean(sub.reduce((a, d) => a + (d.spreadCapturedCents ?? 0), 0), sub.length);
    const a60Samples = sub.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined);
    const a60 = mean(a60Samples.reduce((a, b) => a + b, 0), a60Samples.length);
    const re = mean(sub.reduce((a, d) => a + (d.residualToSettlementCents ?? 0), 0), sub.length);
    const stF = mean(sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0), sub.length);
    const stP = posted > 0 ? (sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0) / posted) : NaN;
    console.log(`| ${qLabel} | ${sub.length.toLocaleString()} | ${fmt(sp)} | ${fmt(a60)} | ${fmt(re)} | ${fmt(stF)} | ${fmt(stP)} |`);
  }
  console.log();

  // (E) By fill-latency bucket.
  console.log("## E. By fill latency (depth_50, filled)");
  console.log();
  console.log("| latency | n filled | spread (¢) | adv60 (¢) | residual (¢) | settlement (¢/filled) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const lb of FILL_LATENCY_BUCKETS) {
    const sub = primary.filter((d) => d.fillLatencyBucketStr === lb);
    if (sub.length === 0) { console.log(`| ${lb} | 0 | — | — | — | — |`); continue; }
    const sp = mean(sub.reduce((a, d) => a + (d.spreadCapturedCents ?? 0), 0), sub.length);
    const a60Samples = sub.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined);
    const a60 = mean(a60Samples.reduce((a, b) => a + b, 0), a60Samples.length);
    const re = mean(sub.reduce((a, d) => a + (d.residualToSettlementCents ?? 0), 0), sub.length);
    const stF = mean(sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0), sub.length);
    console.log(`| ${lb} | ${sub.length.toLocaleString()} | ${fmt(sp)} | ${fmt(a60)} | ${fmt(re)} | ${fmt(stF)} |`);
  }
  console.log();

  // (F) By moneyness.
  console.log("## F. By moneyness (depth_50, filled)");
  console.log();
  console.log("| moneyness | n filled | spread (¢) | adv60 (¢) | residual (¢) | settlement (¢/filled) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const mb of MONEYNESS_BUCKETS) {
    const sub = primary.filter((d) => d.moneynessBucketStr === mb);
    if (sub.length === 0) { console.log(`| ${mb} | 0 | — | — | — | — |`); continue; }
    const sp = mean(sub.reduce((a, d) => a + (d.spreadCapturedCents ?? 0), 0), sub.length);
    const a60Samples = sub.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined);
    const a60 = mean(a60Samples.reduce((a, b) => a + b, 0), a60Samples.length);
    const re = mean(sub.reduce((a, d) => a + (d.residualToSettlementCents ?? 0), 0), sub.length);
    const stF = mean(sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0), sub.length);
    console.log(`| ${mb} | ${sub.length.toLocaleString()} | ${fmt(sp)} | ${fmt(a60)} | ${fmt(re)} | ${fmt(stF)} |`);
  }
  console.log();

  // (G) By time-of-day.
  console.log("## G. By time-of-day (depth_50, filled)");
  console.log();
  console.log("| ToD | n filled | spread (¢) | adv60 (¢) | residual (¢) | settlement (¢/filled) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  const todBuckets = Array.from(new Set(primary.map((d) => d.todBucketStr))).sort();
  for (const tb of todBuckets) {
    const sub = primary.filter((d) => d.todBucketStr === tb);
    if (sub.length === 0) continue;
    const sp = mean(sub.reduce((a, d) => a + (d.spreadCapturedCents ?? 0), 0), sub.length);
    const a60Samples = sub.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined);
    const a60 = mean(a60Samples.reduce((a, b) => a + b, 0), a60Samples.length);
    const re = mean(sub.reduce((a, d) => a + (d.residualToSettlementCents ?? 0), 0), sub.length);
    const stF = mean(sub.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0), sub.length);
    console.log(`| ${tb} | ${sub.length.toLocaleString()} | ${fmt(sp)} | ${fmt(a60)} | ${fmt(re)} | ${fmt(stF)} |`);
  }
  console.log();

  // ---------- pass criteria ----------
  console.log("## Pass criteria");
  console.log();
  const failures: string[] = [];

  // Helper: settlement EV per posted (depth_50, optionally filtered).
  function evPerPosted(filter: (d: DecomposedQuote) => boolean): { ev: number; nPosted: number; nFilledSettled: number } {
    const all = decomposed.filter((d) => d.queueAssumption === PRIMARY_QUEUE_LABEL && filter(d));
    const filledSettled = all.filter((d) => d.filled && d.settlementPnlCents !== null);
    const sum = filledSettled.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0);
    return { ev: all.length > 0 ? sum / all.length : 0, nPosted: all.length, nFilledSettled: filledSettled.length };
  }

  // Criterion 1: EV not entirely from one TTE bucket.
  const positiveTte: Array<{ b: string; ev: number }> = [];
  for (const b of TTE_BUCKETS) {
    const r = evPerPosted((d) => d.tteBucketStr === b);
    if (r.nPosted > 0 && r.ev > 0) positiveTte.push({ b, ev: r.ev });
  }
  console.log(`1. TTE buckets with positive settlement EV: **${positiveTte.length}** (${positiveTte.map((p) => `${p.b}=${fmt(p.ev)}¢`).join(", ") || "none"})`);
  if (positiveTte.length < 2) failures.push("EV survives in < 2 TTE buckets");

  // Criterion 2: EV not from one side.
  const yesEv = evPerPosted((d) => d.side === "yes");
  const noEv = evPerPosted((d) => d.side === "no");
  console.log(`2. Side EV/posted: yes-bid **${fmt(yesEv.ev)}¢**, no-bid **${fmt(noEv.ev)}¢**`);
  if (yesEv.ev <= 0) failures.push(`YES-bid EV not positive (${fmt(yesEv.ev)}¢)`);
  if (noEv.ev <= 0) failures.push(`NO-bid EV not positive (${fmt(noEv.ev)}¢)`);

  // Criterion 3: adverse selection bounded AND recoverable by residual.
  const a60 = primary.map((d) => d.adverseSelectionCents[60000]).filter((v): v is number => v !== null && v !== undefined);
  const meanA60 = mean(a60.reduce((a, b) => a + b, 0), a60.length);
  const residuals = primary.map((d) => d.residualToSettlementCents).filter((v): v is number => v !== null);
  const meanResidual = mean(residuals.reduce((a, b) => a + b, 0), residuals.length);
  console.log(`3. Mean adv sel @ 60s: **${fmt(meanA60)}¢**, mean residual: **${fmt(meanResidual)}¢**, recovery ratio: **${(meanResidual / -meanA60).toFixed(2)}**`);
  if (Math.abs(meanA60) > 2.0) failures.push(`Adverse selection unbounded: ${fmt(meanA60)}¢ (limit ±2¢)`);
  if (meanResidual + meanA60 < 0) failures.push(`Residual does not recover adverse selection: residual ${fmt(meanResidual)}¢ + adv60 ${fmt(meanA60)}¢ < 0`);

  // Criterion 4: leave-best-bucket-out.
  // Find the TTE bucket with highest absolute contribution to total settlement, remove it, recompute total EV/posted.
  const tteContribs: Array<{ b: TteBucket; contrib: number }> = [];
  for (const b of TTE_BUCKETS) {
    const all = decomposed.filter((d) => d.queueAssumption === PRIMARY_QUEUE_LABEL && d.tteBucketStr === b);
    const filledSettled = all.filter((d) => d.filled && d.settlementPnlCents !== null);
    const contrib = filledSettled.reduce((a, d) => a + (d.settlementPnlCents ?? 0), 0);
    tteContribs.push({ b, contrib });
  }
  const bestBucket = tteContribs.reduce((best, cur) => cur.contrib > best.contrib ? cur : best, tteContribs[0]!);
  const evWithoutBest = evPerPosted((d) => d.tteBucketStr !== bestBucket.b);
  const evAll = evPerPosted(() => true);
  console.log(`4. Leave-best-bucket-out: best TTE = **${bestBucket.b}** (contrib ${fmt(bestBucket.contrib / Math.max(1, evAll.nPosted))}¢/posted overall)`);
  console.log(`   - EV/posted with ALL buckets: ${fmt(evAll.ev)}¢ (n=${evAll.nPosted})`);
  console.log(`   - EV/posted EXCLUDING ${bestBucket.b}: **${fmt(evWithoutBest.ev)}¢** (n=${evWithoutBest.nPosted})`);
  if (evWithoutBest.ev <= 0) failures.push(`Leave-best-out EV non-positive: ${fmt(evWithoutBest.ev)}¢`);

  console.log();
  if (failures.length === 0) {
    console.log("**ALL CRITERIA PASS** — edge is sufficiently distributed; safe to proceed to BTC-only maker replay.");
  } else {
    console.log(`**${failures.length} CRITERIA FAILED** — edge is too concentrated; STOP before building the maker replay.`);
    console.log();
    for (const f of failures) console.log(`- ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
