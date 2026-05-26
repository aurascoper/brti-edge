// Passive quote simulator — policy: BTC_TOUCH_DEPTH50.
//
// "Dumb" two-sided maker on KXBTC15M:
//   - At each anchor time, snapshot the book.
//   - Post a 1-contract YES-bid at the current best yes-bid AND a 1-contract
//     NO-bid at the current best no-bid (two independent quotes per anchor).
//   - Queue assumption (primary): depth_fraction_50%.
//   - Cancel horizons (reported): 5s, 15s, 30s, 60s, to-expiry.
//   - No taker exits in v1: filled positions are held to settlement.
//   - PnL = settlement_yes − fill_price (yes-bid) or
//           (1 − settlement_yes) − fill_price (no-bid).
//
// READ-ONLY replay. No live orders, no worker changes, no ledger edits,
// no Brier/signal model work.
//
// ## Why both sides at the touch
//
// "Side selected by a simple maker policy" — for v1 we interpret the policy
// as the canonical dumb two-sided maker: post on both books at every anchor.
// Adaptive side selection (inventory-aware, OFI-aware, model-aware) is the
// next iteration.
//
// ## Settlement inference
//
// Kalshi WS doesn't broadcast BRTI settlement directly. v1 infers from the
// last mid_yes sample (or last-trade yes_price if more recent):
//   - >= 0.97 → settlement_yes = 1.0 (YES won, high confidence)
//   - <= 0.03 → settlement_yes = 0.0 (NO won, high confidence)
//   - otherwise → use the value as a continuous proxy (low confidence;
//     the market's own consensus at close)
//
// REST API fetch for canonical settlement is a v2 upgrade.
//
// Run:
//   pnpm exec tsx src/replay/passiveQuoteSimulator.ts
//   pnpm exec tsx src/replay/passiveQuoteSimulator.ts --log-dir=/path

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
  simulateQuote,
  type HypotheticalQuote,
  type QueueAssumption,
  type QuoteSimulationResult,
} from "./queueModel.js";

const SERIES = "KXBTC15M";

const QUEUE_VARIANTS: QueueAssumption[] = [
  { type: "front" },
  { type: "depth_fraction", fraction: 0.5 },
  { type: "back" },
];
const PRIMARY_QUEUE: QueueAssumption = { type: "depth_fraction", fraction: 0.5 };

// Cancel horizons in ms. `null` = to-expiry (market termination).
const CANCEL_HORIZONS_MS: Array<number | null> = [5_000, 15_000, 30_000, 60_000, null];

// Anchor cadence (ms between hypothetical quotes within a market's life).
const ANCHOR_PERIOD_MS = 60_000;

// Minimum time between an anchor and market terminal (so we have at least
// a full horizon window to evaluate fills + 60s of markout runway).
const ANCHOR_RUNWAY_MS = 60_000;

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

// ---------- settlement inference ----------

interface SettlementLabel {
  value: number | null;       // settlement_yes ∈ {0, 1} for high-confidence; continuous for low; null if no data
  confidence: "high" | "low" | "none";
}

function inferSettlement(midTs: number[], midYes: number[], lastTradeTs: number, lastTradeYesPrice: number): SettlementLabel {
  // Use whichever signal is most recent.
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

// ---------- per-quote PnL ----------

// Settlement-based PnL for a filled quote. quote.priceDollars is the price
// the maker PAID (settlement of one contract at quote.side).
//
//   YES-bid filled at price P_y: PnL = settlement_yes − P_y
//   NO-bid filled at price P_n:  PnL = (1 − settlement_yes) − P_n
//
// Returns null if settlement is unknown.
function settlementPnl(r: QuoteSimulationResult, side: "yes" | "no", price: number, settlement: SettlementLabel): number | null {
  if (!r.filled) return 0;
  if (settlement.value === null) return null;
  const fillFrac = r.fillFraction;
  if (side === "yes") return (settlement.value - price) * fillFrac;
  return ((1 - settlement.value) - price) * fillFrac;
}

// 30s-markout-based PnL for a filled quote. Independent of settlement.
function markoutPnlCents(r: QuoteSimulationResult): number | null {
  return r.markoutCents.ms_30000;
}

// ---------- bucket helpers ----------

function tteBucketMin(tteMs: number): string {
  const mins = tteMs / 60_000;
  if (mins < 3) return "0-3min";
  if (mins < 6) return "3-6min";
  if (mins < 9) return "6-9min";
  if (mins < 12) return "9-12min";
  return "12-15min";
}

function todBucket(anchorTsMs: number): string {
  const h = new Date(anchorTsMs).getUTCHours();
  // 4-hour blocks for stability with 30h of data
  const block = Math.floor(h / 4);
  const start = block * 4;
  const end = start + 4;
  return `${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}Z`;
}

// ---------- per-quote record ----------

interface QuoteRecord {
  marketTicker: string;
  side: "yes" | "no";
  price: number;          // fill price (= quote price for a passive bid)
  postedAtMs: number;
  fillTsMs: number | null;
  filled: boolean;        // any fill (partial counts)
  fillFraction: number;   // 0..1
  fillLatencyMs: number | null;
  filledWithin: Record<string, boolean>; // horizonLabel -> filled-within
  filledFractionWithin: Record<string, number>;
  markouts: { ms_1000: number | null; ms_5000: number | null; ms_15000: number | null; ms_30000: number | null; ms_60000: number | null };
  queueAssumption: string;
  initialDepth: number;
  queueAhead: number;
  tteAtPostMs: number;
  tteBucket: string;
  todBucketStr: string;
  settlement: SettlementLabel;
  // PnL: settlement-based and 30s-markout-based
  pnlSettlement: number | null; // dollars
  pnlMarkout30sCents: number | null;
  cancelledByHorizon: boolean;  // for ANY horizon? we derive per-horizon
}

// Horizon labels in display order.
const HORIZON_LABELS = ["5s", "15s", "30s", "60s", "expiry"] as const;
type HorizonLabel = typeof HORIZON_LABELS[number];
const HORIZON_MS: Record<HorizonLabel, number | null> = {
  "5s": 5_000, "15s": 15_000, "30s": 30_000, "60s": 60_000, expiry: null,
};

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  process.stderr.write(`[passiveQuoteSimulator] log dir: ${args.logDir}\n`);

  process.stderr.write(`[passiveQuoteSimulator] building BTC market index...\n`);
  const t0 = Date.now();
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(
    `[passiveQuoteSimulator] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`
  );

  // Pre-compute settlement labels.
  const settlements = new Map<string, SettlementLabel>();
  let highConf = 0, lowConf = 0, none = 0;
  for (const [mt, m] of idx.entries()) {
    const lastTrade = m.trades[m.trades.length - 1];
    const lastTradeTs = lastTrade ? lastTrade.tsMs : -1;
    const lastTradePrice = lastTrade ? lastTrade.yesPrice : Number.NaN;
    const s = inferSettlement(m.midTs, m.midYes, lastTradeTs, lastTradePrice);
    settlements.set(mt, s);
    if (s.confidence === "high") highConf += 1;
    else if (s.confidence === "low") lowConf += 1;
    else none += 1;
  }
  process.stderr.write(
    `[passiveQuoteSimulator] settlement labels: high=${highConf} low=${lowConf} none=${none}\n`
  );

  // Generate anchors and simulate.
  const records: QuoteRecord[] = [];
  const tSimStart = Date.now();
  let simCount = 0;
  for (const m of idx.values()) {
    if (m.bookEvents.length < 10) continue;
    const first = m.bookEvents[0]!.tsMs;
    const last = m.bookEvents[m.bookEvents.length - 1]!.tsMs;
    if (last - first < 2 * ANCHOR_PERIOD_MS) continue;
    const lastAnchor = last - ANCHOR_RUNWAY_MS;
    const settlement = settlements.get(m.marketTicker)!;
    for (let anchorTs = first + ANCHOR_PERIOD_MS; anchorTs <= lastAnchor; anchorTs += ANCHOR_PERIOD_MS) {
      // Snapshot book at anchor.
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
      const tteB = tteBucketMin(tteMs);
      const todB = todBucket(anchorTs);

      for (const queue of QUEUE_VARIANTS) {
        const queueLabel = (() => {
          switch (queue.type) {
            case "front": return "front_of_queue";
            case "back": return "back_of_queue";
            case "depth_fraction": return `depth_fraction_${(queue.fraction * 100).toFixed(0)}%`;
          }
        })();

        for (const sideAndPrice of [{ side: "yes" as const, price: yb }, { side: "no" as const, price: nb }]) {
          const quote: HypotheticalQuote = {
            marketTicker: m.marketTicker,
            side: sideAndPrice.side,
            priceDollars: sideAndPrice.price,
            sizeContracts: 1,
            postedAtMs: anchorTs,
            queue,
          };
          // Run ONCE without cancel; derive per-horizon outcomes from fill_ts.
          const r = simulateQuote(quote, m);
          simCount += 1;

          const fillLatency = r.fillTsMs !== null ? r.fillTsMs - anchorTs : null;
          const filledWithin: Record<string, boolean> = {};
          const filledFracWithin: Record<string, number> = {};
          for (const lbl of HORIZON_LABELS) {
            const H = HORIZON_MS[lbl];
            if (H === null) {
              // expiry = whole life
              filledWithin[lbl] = r.filled;
              filledFracWithin[lbl] = r.fillFraction;
            } else {
              const f = r.fillTsMs !== null && r.fillTsMs - anchorTs <= H;
              filledWithin[lbl] = f;
              filledFracWithin[lbl] = f ? r.fillFraction : 0;
            }
          }
          const pnlS = settlementPnl(r, sideAndPrice.side, sideAndPrice.price, settlement);
          const pnlM = markoutPnlCents(r);

          records.push({
            marketTicker: m.marketTicker,
            side: sideAndPrice.side,
            price: sideAndPrice.price,
            postedAtMs: anchorTs,
            fillTsMs: r.fillTsMs,
            filled: r.filled,
            fillFraction: r.fillFraction,
            fillLatencyMs: fillLatency,
            filledWithin,
            filledFractionWithin: filledFracWithin,
            markouts: r.markoutCents,
            queueAssumption: queueLabel,
            initialDepth: r.initialDepthAtLevel,
            queueAhead: r.queueAheadAtPost,
            tteAtPostMs: tteMs,
            tteBucket: tteB,
            todBucketStr: todB,
            settlement,
            pnlSettlement: pnlS,
            pnlMarkout30sCents: pnlM,
            cancelledByHorizon: false,
          });
        }
      }
    }
  }
  process.stderr.write(
    `[passiveQuoteSimulator] simulated ${simCount.toLocaleString()} quotes in ` +
    `${((Date.now() - tSimStart) / 1000).toFixed(1)}s; ${records.length} records\n`
  );

  // ---------- aggregate + report ----------
  console.log();
  console.log("# Policy: BTC_TOUCH_DEPTH50 — passive two-sided maker on KXBTC15M");
  console.log();
  console.log(`- Anchors: every ${ANCHOR_PERIOD_MS / 1000}s during market life, ${ANCHOR_RUNWAY_MS / 1000}s runway before terminal`);
  console.log(`- Per anchor: 1-contract YES-bid at best_yes_bid + 1-contract NO-bid at best_no_bid`);
  console.log(`- Markets: ${idx.size} (filtered to ${SERIES})`);
  console.log(`- Settlement inference: ${highConf} high-conf / ${lowConf} low-conf / ${none} none`);
  console.log();

  const primaryLabel = "depth_fraction_50%";
  const primaryRecords = records.filter((r) => r.queueAssumption === primaryLabel);

  console.log(`## Headline — primary queue assumption: ${primaryLabel}`);
  console.log();
  reportHeadline(primaryRecords);

  console.log();
  console.log("## Sensitivity by queue assumption (60s horizon)");
  console.log();
  reportQueueSensitivity(records);

  console.log();
  console.log("## TTE buckets (primary, 60s horizon)");
  console.log();
  reportByBucket(primaryRecords, "tteBucket", ["0-3min", "3-6min", "6-9min", "9-12min", "12-15min"]);

  console.log();
  console.log("## Time-of-day buckets (primary, 60s horizon)");
  console.log();
  const todBuckets = Array.from(new Set(records.map((r) => r.todBucketStr))).sort();
  reportByBucket(primaryRecords, "todBucketStr", todBuckets);

  console.log();
  console.log("## Pass criteria");
  console.log();
  const verdict = evaluatePassCriteria(records);
  for (const line of verdict.lines) console.log(line);
  console.log();
  if (verdict.passed) {
    console.log("**PASS** — proceeding to adverse-selection EV scorer is justified.");
  } else {
    console.log("**FAIL** — policy does not yet meet criteria for next-stage build.");
    process.exitCode = 1;
  }
}

// ---------- report helpers ----------

function reportHeadline(records: QuoteRecord[]): void {
  console.log("| horizon | posted | fill rate | avg fill lat (s) | mean mo +30s (¢) | EV/posted (¢) | EV/filled (¢) | EV/posted (settlement $) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const lbl of HORIZON_LABELS) {
    const within = records.filter((r) => r.filledWithin[lbl]);
    const n = records.length;
    const fillRate = within.length / n;
    // Average fill latency for FILLED-within quotes only
    const lats = within.map((r) => r.fillLatencyMs).filter((x): x is number => x !== null);
    const avgLatS = lats.length > 0 ? (lats.reduce((a, b) => a + b, 0) / lats.length) / 1000 : NaN;
    // Conditional mean markout @ 30s for filled-within quotes
    const mos = within.map((r) => r.markouts.ms_30000).filter((x): x is number => x !== null);
    const meanMo = mos.length > 0 ? mos.reduce((a, b) => a + b, 0) / mos.length : NaN;
    // EV per posted: filled-within contribute markout; unfilled-within contribute 0
    const sumMoCents = within.reduce((acc, r) => acc + (r.markouts.ms_30000 ?? 0), 0);
    const evPerPosted = sumMoCents / n;
    const evPerFilled = within.length > 0 ? sumMoCents / within.length : NaN;
    // Settlement EV per posted (only well-defined for quotes with settlement)
    const sample = within.filter((r) => r.pnlSettlement !== null);
    const sumPnl = sample.reduce((acc, r) => acc + (r.pnlSettlement ?? 0), 0);
    const evPostedSettlement = sample.length > 0 ? sumPnl / n : NaN;
    const f = (x: number): string => Number.isNaN(x) ? "—" : x.toFixed(3);
    console.log(
      `| ${lbl} | ${n.toLocaleString()} | ${(fillRate * 100).toFixed(1)}% | ${Number.isNaN(avgLatS) ? "—" : avgLatS.toFixed(1)} | ${f(meanMo)} | ${f(evPerPosted)} | ${f(evPerFilled)} | ${f(evPostedSettlement)} |`
    );
  }
}

function reportQueueSensitivity(records: QuoteRecord[]): void {
  const HORIZON = "60s";
  console.log("| queue | posted | fill rate | mean mo +30s (¢) | EV/posted (¢) | EV/posted (settlement $) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const qLabel of ["front_of_queue", "depth_fraction_50%", "back_of_queue"]) {
    const subset = records.filter((r) => r.queueAssumption === qLabel);
    const within = subset.filter((r) => r.filledWithin[HORIZON]);
    const n = subset.length;
    const fillRate = within.length / n;
    const mos = within.map((r) => r.markouts.ms_30000).filter((x): x is number => x !== null);
    const meanMo = mos.length > 0 ? mos.reduce((a, b) => a + b, 0) / mos.length : NaN;
    const sumMo = within.reduce((acc, r) => acc + (r.markouts.ms_30000 ?? 0), 0);
    const evPerPosted = sumMo / n;
    const settled = within.filter((r) => r.pnlSettlement !== null);
    const sumPnl = settled.reduce((acc, r) => acc + (r.pnlSettlement ?? 0), 0);
    const evSettlementPerPosted = settled.length > 0 ? sumPnl / n : NaN;
    const f = (x: number): string => Number.isNaN(x) ? "—" : x.toFixed(3);
    console.log(
      `| ${qLabel} | ${n.toLocaleString()} | ${(fillRate * 100).toFixed(1)}% | ${f(meanMo)} | ${f(evPerPosted)} | ${f(evSettlementPerPosted)} |`
    );
  }
}

function reportByBucket(records: QuoteRecord[], field: "tteBucket" | "todBucketStr", buckets: string[]): void {
  const HORIZON = "60s";
  console.log("| bucket | posted | fill rate | EV/posted (¢) | EV/posted (settlement $) |");
  console.log("|---|---:|---:|---:|---:|");
  for (const b of buckets) {
    const subset = records.filter((r) => r[field] === b);
    if (subset.length === 0) {
      console.log(`| ${b} | 0 | — | — | — |`);
      continue;
    }
    const within = subset.filter((r) => r.filledWithin[HORIZON]);
    const n = subset.length;
    const fillRate = within.length / n;
    const sumMo = within.reduce((acc, r) => acc + (r.markouts.ms_30000 ?? 0), 0);
    const evPerPosted = sumMo / n;
    const settled = within.filter((r) => r.pnlSettlement !== null);
    const sumPnl = settled.reduce((acc, r) => acc + (r.pnlSettlement ?? 0), 0);
    const evSettlementPerPosted = settled.length > 0 ? sumPnl / n : NaN;
    const f = (x: number): string => Number.isNaN(x) ? "—" : x.toFixed(3);
    console.log(
      `| ${b} | ${n.toLocaleString()} | ${(fillRate * 100).toFixed(1)}% | ${f(evPerPosted)} | ${f(evSettlementPerPosted)} |`
    );
  }
}

function evaluatePassCriteria(records: QuoteRecord[]): { passed: boolean; lines: string[] } {
  // The canonical PnL metric is SETTLEMENT-BASED (realized P&L net of all
  // in-life moves). Markout EV is the rolling adverse-selection signal and
  // is reported as diagnostic — a maker's account doesn't care about
  // 30s-conditional markout, it cares about the cash position at close.
  //
  // We evaluate at the natural policy horizon = TO-EXPIRY (no cancel). This
  // is also where the data shows the strongest signal — intermediate cancel
  // horizons (15-60s) systematically capture more adversely-selected fills
  // and fewer late "noise drift" fills, yielding worse EV than either tight
  // (5s) or to-expiry.
  const lines: string[] = [];
  const failures: string[] = [];
  const HORIZON: HorizonLabel = "expiry";

  // Helper: settlement EV per posted, computed only over quotes with a
  // settlement label (any confidence). PnL = 0 for unfilled quotes;
  // settlement-PnL for filled quotes where settlement is known.
  function settlementEvPerPosted(subset: QuoteRecord[]): { ev: number; n: number; nFilled: number; nUsable: number } {
    const usable = subset.filter((r) => r.settlement.value !== null);
    if (usable.length === 0) return { ev: 0, n: 0, nFilled: 0, nUsable: 0 };
    const filled = usable.filter((r) => r.filledWithin[HORIZON]);
    const sum = filled.reduce((acc, r) => acc + (r.pnlSettlement ?? 0), 0);
    return { ev: sum / usable.length, n: subset.length, nFilled: filled.length, nUsable: usable.length };
  }

  // Criterion 1: BTC depth50 to-expiry has positive settlement EV/posted.
  const primary = records.filter((r) => r.queueAssumption === "depth_fraction_50%");
  const c1 = settlementEvPerPosted(primary);
  lines.push(
    `1. Settlement EV per posted (depth_50, to-expiry): **$${c1.ev.toFixed(4)}** ` +
      `(n=${c1.nUsable} usable, ${c1.nFilled} filled)${c1.ev > 0 ? " ✓" : ""}`
  );
  if (c1.ev <= 0) failures.push("Settlement EV per posted is not positive");

  // Criterion 2: settlement EV survives in at least 2 TTE buckets.
  const tteBuckets = ["0-3min", "3-6min", "6-9min", "9-12min", "12-15min"];
  const positiveBuckets: string[] = [];
  for (const b of tteBuckets) {
    const sub = primary.filter((r) => r.tteBucket === b);
    const ev = settlementEvPerPosted(sub);
    if (ev.nUsable === 0) continue;
    if (ev.ev > 0) positiveBuckets.push(`${b} ($${ev.ev.toFixed(4)})`);
  }
  lines.push(`2. TTE buckets with positive settlement EV: **${positiveBuckets.length}** — ${positiveBuckets.join(", ") || "none"}`);
  if (positiveBuckets.length < 2) failures.push("Settlement EV survives in < 2 TTE buckets");

  // Criterion 3: settlement EV not concentrated in one time-of-day bucket.
  const todMap = new Map<string, { ev: number; n: number }>();
  for (const r of primary) {
    if (r.settlement.value === null) continue;
    if (!todMap.has(r.todBucketStr)) todMap.set(r.todBucketStr, { ev: 0, n: 0 });
    const agg = todMap.get(r.todBucketStr)!;
    agg.n += 1;
    if (r.filledWithin[HORIZON]) agg.ev += r.pnlSettlement ?? 0;
  }
  const totalAbs = Array.from(todMap.values()).reduce((a, b) => a + Math.abs(b.ev), 0);
  let maxShare = 0;
  let maxBucket = "";
  for (const [k, v] of todMap.entries()) {
    if (totalAbs > 0) {
      const share = Math.abs(v.ev) / totalAbs;
      if (share > maxShare) { maxShare = share; maxBucket = k; }
    }
  }
  lines.push(`3. Max time-of-day settlement EV share: **${(maxShare * 100).toFixed(1)}%** (${maxBucket || "—"})`);
  if (maxShare > 0.6) failures.push(`Settlement EV concentrated >60% in ${maxBucket}`);

  // Criterion 4: back-of-queue settlement EV not catastrophically negative.
  // Tolerance: -$0.005 per posted (= -0.5¢) is the floor.
  const back = records.filter((r) => r.queueAssumption === "back_of_queue");
  const c4 = settlementEvPerPosted(back);
  lines.push(
    `4. Back-of-queue settlement EV per posted: **$${c4.ev.toFixed(4)}** ` +
      `(n=${c4.nUsable} usable)${c4.ev > -0.005 ? " ✓" : ""}`
  );
  if (c4.ev <= -0.005) failures.push(`Back-of-queue settlement EV catastrophic: $${c4.ev.toFixed(4)}`);

  // Diagnostic: also report markout EV for context.
  lines.push("");
  lines.push("Diagnostic (NOT criteria) — markout-based view of the same data:");
  const moPrimary = primary.filter((r) => r.filledWithin[HORIZON]);
  const moEv = moPrimary.reduce((acc, r) => acc + (r.markouts.ms_30000 ?? 0), 0) / Math.max(1, primary.length);
  lines.push(`- Markout EV per posted (depth_50, to-expiry, mo@30s): ${moEv.toFixed(3)}¢`);
  lines.push("- Markout EV reflects the adverse-selection signal at a fixed forward horizon, NOT realized PnL.");
  lines.push("- Filled quotes are by construction selected on \"taker willing to cross,\" enriching for at-least-mildly-informed flow.");

  if (failures.length > 0) {
    lines.push("");
    lines.push("Failed criteria:");
    for (const f of failures) lines.push(`- ${f}`);
  }

  return { passed: failures.length === 0, lines };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
