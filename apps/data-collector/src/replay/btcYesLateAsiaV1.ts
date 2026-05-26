// PRE-REGISTERED POLICY: BTC_YES_LATE_ASIA_v1
//
// This implementation is the code form of the pre-registration committed at:
//   docs/research/kalshi-policy-preregistration-btc-yes-late-asia-v1-2026-05-26.md
//
// The constants at the top of this file are the FROZEN policy parameters.
// They were derived from the in-sample 30h dataset, and the pre-registration
// commits the operator to NOT modifying them in response to either the
// in-sample exploratory result or any future holdout result.
//
// If the policy fails on a holdout, this code is rejected as a whole — a
// future v2 would require a new pre-registration document and would be
// implemented in a sibling file (btcYesLateAsiaV2.ts), not by editing this
// file.
//
// READ-ONLY replay. No live orders, no worker changes, no ledger edits.
//
// Run:
//   pnpm exec tsx src/replay/btcYesLateAsiaV1.ts                    # exploratory in-sample
//   pnpm exec tsx src/replay/btcYesLateAsiaV1.ts --log-dir=...      # against a different log dir (e.g. holdout)
//   pnpm exec tsx src/replay/btcYesLateAsiaV1.ts --label=holdout-XX # tag the output for filing

import { resolve } from "node:path";
import {
  applyDelta,
  applySnapshot,
  applyTerminalSnapshot,
  bestYesBid,
  newBookState,
} from "./bookReconstructor.js";
import {
  buildMarketIndex,
  simulateQuote,
  type HypotheticalQuote,
  type QueueAssumption,
} from "./queueModel.js";

// =========================================================================
// FROZEN POLICY PARAMETERS — DO NOT MODIFY WITHOUT A NEW PRE-REGISTRATION
// =========================================================================

const POLICY_NAME = "BTC_YES_LATE_ASIA_v1";
const PREREG_DOC = "docs/research/kalshi-policy-preregistration-btc-yes-late-asia-v1-2026-05-26.md";

const SERIES = "KXBTC15M";
const SIDE = "yes" as const; // YES-bid only
const SIZE_CONTRACTS = 1;
const QUEUE_ASSUMPTION: QueueAssumption = { type: "depth_fraction", fraction: 0.5 };

// TTE filter: post only when time-to-expiry (in minutes) >= 6.
// Equivalent to "post during the first 9 minutes of a market's 15-minute life".
const TTE_MIN_MINUTES = 6;

// Time-of-day filter: post only when UTC hour is in [20, 24) ∪ [0, 8).
// (the 12 hours outside the US daytime block of 08-20Z)
function isEligibleHour(utcHour: number): boolean {
  return (utcHour >= 20 && utcHour < 24) || (utcHour >= 0 && utcHour < 8);
}

// Anchor cadence and runway (operational simulator parameters, not policy
// knobs — these match the validated passive-simulator infrastructure).
const ANCHOR_PERIOD_MS = 60_000;
const ANCHOR_RUNWAY_MS = 60_000;

// =========================================================================
// IMPLEMENTATION — uses validated primitives from queueModel + bookReconstructor
// =========================================================================

interface Args { logDir: string; label: string }
function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return {
    logDir: args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector"),
    label: args.label ?? "in-sample-2026-05-25_to_2026-05-26",
  };
}

function isBtcMarket(mt: string): boolean { return mt.startsWith(SERIES + "-"); }

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

// TTE buckets (3 inclusive after filter).
type TteBucket = "6-9min" | "9-12min" | "12-15min";
function tteBucket(tteMs: number): TteBucket | null {
  const mins = tteMs / 60_000;
  if (mins < TTE_MIN_MINUTES) return null;
  if (mins < 9) return "6-9min";
  if (mins < 12) return "9-12min";
  return "12-15min";
}

// ToD blocks (3 inclusive after filter).
type TodBlock = "20-24Z" | "00-04Z" | "04-08Z";
function todBlock(anchorTsMs: number): TodBlock | null {
  const h = new Date(anchorTsMs).getUTCHours();
  if (h >= 20 && h < 24) return "20-24Z";
  if (h >= 0 && h < 4) return "00-04Z";
  if (h >= 4 && h < 8) return "04-08Z";
  return null; // not eligible
}

// 2-hour wall-clock blocks (for concentration check #6).
function wallClock2hBlock(anchorTsMs: number): string {
  const d = new Date(anchorTsMs);
  const hh = d.getUTCHours();
  const block = Math.floor(hh / 2) * 2;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(block).padStart(2, "0")}`;
}

interface QuoteRecord {
  marketTicker: string;
  postedAtMs: number;
  fillTsMs: number | null;
  filled: boolean;
  fillFraction: number;
  tteBucketStr: TteBucket;
  todBlockStr: TodBlock;
  wallClock2hKey: string;
  settlementValue: number | null;
  settlementConfidence: "high" | "low" | "none";
  pnlSettlement: number | null; // dollars
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.stderr.write(`[${POLICY_NAME}] pre-registration: ${PREREG_DOC}\n`);
  process.stderr.write(`[${POLICY_NAME}] log dir: ${args.logDir}\n`);
  process.stderr.write(`[${POLICY_NAME}] label: ${args.label}\n`);

  const t0 = Date.now();
  process.stderr.write(`[${POLICY_NAME}] building BTC market index...\n`);
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(`[${POLICY_NAME}] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

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

  // Generate anchors with frozen filters; simulate; record.
  const records: QuoteRecord[] = [];
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
      const tteMs = last - anchorTs;
      const tteB = tteBucket(tteMs);
      if (tteB === null) continue; // TTE filter
      const todB = todBlock(anchorTs);
      if (todB === null) continue; // ToD filter

      // Snapshot book at anchor.
      const state = newBookState(m.marketTicker, "");
      for (const ev of m.bookEvents) {
        if (ev.tsMs > anchorTs) break;
        if (ev.type === "snapshot") applySnapshot(state, ev);
        else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
        else applyDelta(state, ev);
      }
      const yb = bestYesBid(state);
      if (yb === null) continue;

      const quote: HypotheticalQuote = {
        marketTicker: m.marketTicker,
        side: SIDE,
        priceDollars: yb,
        sizeContracts: SIZE_CONTRACTS,
        postedAtMs: anchorTs,
        queue: QUEUE_ASSUMPTION,
      };
      const r = simulateQuote(quote, m);
      simCount += 1;

      let pnl: number | null = null;
      if (r.filled && settlement.value !== null) {
        // YES-bid PnL = (settlement_yes - price) * fillFrac
        pnl = (settlement.value - yb) * r.fillFraction;
      } else if (!r.filled) {
        pnl = 0;
      }

      records.push({
        marketTicker: m.marketTicker,
        postedAtMs: anchorTs,
        fillTsMs: r.fillTsMs,
        filled: r.filled,
        fillFraction: r.fillFraction,
        tteBucketStr: tteB,
        todBlockStr: todB,
        wallClock2hKey: wallClock2hBlock(anchorTs),
        settlementValue: settlement.value,
        settlementConfidence: settlement.confidence,
        pnlSettlement: pnl,
      });
    }
  }
  process.stderr.write(`[${POLICY_NAME}] simulated ${simCount.toLocaleString()} quotes in ${((Date.now() - tSim) / 1000).toFixed(1)}s\n`);

  // ---------- aggregate ----------
  const posted = records.length;
  const filled = records.filter((r) => r.filled);
  const usable = records.filter((r) => r.pnlSettlement !== null);
  const fillRate = posted > 0 ? filled.length / posted : 0;
  const sumPnl = usable.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
  const evPosted = usable.length > 0 ? sumPnl / usable.length : 0;
  const evFilled = filled.filter((r) => r.pnlSettlement !== null).length > 0
    ? sumPnl / filled.filter((r) => r.pnlSettlement !== null).length
    : 0;

  // ---------- output ----------
  const isInSample = args.label.includes("in-sample");

  console.log();
  console.log(`# ${POLICY_NAME} run — \`${args.label}\``);
  console.log();
  if (isInSample) {
    console.log("> **EXPLORATORY IN-SAMPLE RUN.** This is NOT validation. The policy filters were");
    console.log("> derived from this same 30h dataset; testing them on it is selection bias.");
    console.log("> Use the numbers below only as a sanity check that the implementation matches");
    console.log(`> the pre-registered spec (\`${PREREG_DOC}\`).`);
  } else {
    console.log("> **HOLDOUT VALIDATION RUN.** Apply the 7 pass gates from the pre-registration");
    console.log(`> doc (\`${PREREG_DOC}\`) below.`);
  }
  console.log();
  console.log(`- Policy: ${POLICY_NAME}`);
  console.log(`- Pre-registration: ${PREREG_DOC}`);
  console.log(`- Log dir: ${args.logDir}`);
  console.log(`- Markets indexed: ${idx.size}`);
  console.log();
  console.log("## Headline");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| posted | **${posted.toLocaleString()}** |`);
  console.log(`| filled | **${filled.length.toLocaleString()}** |`);
  console.log(`| fill rate | **${(fillRate * 100).toFixed(1)}%** |`);
  console.log(`| settlement EV per posted | **$${evPosted.toFixed(4)}** (= ${(evPosted * 100).toFixed(3)}¢) |`);
  console.log(`| settlement EV per filled | **$${evFilled.toFixed(4)}** (= ${(evFilled * 100).toFixed(3)}¢) |`);
  console.log(`| total settlement PnL | **$${sumPnl.toFixed(4)}** |`);
  console.log(`| usable records (with settlement label) | ${usable.length} |`);
  console.log();

  // ---------- TTE breakdown ----------
  console.log("## By TTE bucket");
  console.log();
  console.log("| TTE | posted | filled | fill rate | EV/posted ($) | EV/filled ($) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const b of ["6-9min", "9-12min", "12-15min"] as const) {
    const sub = records.filter((r) => r.tteBucketStr === b);
    const subFilled = sub.filter((r) => r.filled);
    const subUsable = sub.filter((r) => r.pnlSettlement !== null);
    const subSum = subUsable.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
    const subFilledUsable = subFilled.filter((r) => r.pnlSettlement !== null);
    if (sub.length === 0) { console.log(`| ${b} | 0 | 0 | — | — | — |`); continue; }
    const fr = subFilled.length / sub.length;
    const evP = subUsable.length > 0 ? subSum / subUsable.length : 0;
    const evF = subFilledUsable.length > 0 ? subSum / subFilledUsable.length : 0;
    console.log(`| ${b} | ${sub.length} | ${subFilled.length} | ${(fr * 100).toFixed(1)}% | $${evP.toFixed(4)} | $${evF.toFixed(4)} |`);
  }
  console.log();

  // ---------- ToD breakdown ----------
  console.log("## By time-of-day block");
  console.log();
  console.log("| ToD | posted | filled | fill rate | EV/posted ($) | EV/filled ($) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const b of ["20-24Z", "00-04Z", "04-08Z"] as const) {
    const sub = records.filter((r) => r.todBlockStr === b);
    const subFilled = sub.filter((r) => r.filled);
    const subUsable = sub.filter((r) => r.pnlSettlement !== null);
    const subSum = subUsable.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
    const subFilledUsable = subFilled.filter((r) => r.pnlSettlement !== null);
    if (sub.length === 0) { console.log(`| ${b} | 0 | 0 | — | — | — |`); continue; }
    const fr = subFilled.length / sub.length;
    const evP = subUsable.length > 0 ? subSum / subUsable.length : 0;
    const evF = subFilledUsable.length > 0 ? subSum / subFilledUsable.length : 0;
    console.log(`| ${b} | ${sub.length} | ${subFilled.length} | ${(fr * 100).toFixed(1)}% | $${evP.toFixed(4)} | $${evF.toFixed(4)} |`);
  }
  console.log();

  // ---------- pass gates (applied identically in-sample and on holdout) ----------
  console.log("## Pass gates");
  console.log();
  const failures: string[] = [];

  // Gate 1: EV/posted > 0
  const g1 = evPosted > 0;
  console.log(`1. Settlement EV per posted > 0: **${evPosted >= 0 ? "+" : ""}$${evPosted.toFixed(4)}**${g1 ? " ✓" : " ✗"}`);
  if (!g1) failures.push("EV/posted not > 0");

  // Gate 2: EV/filled > 0
  const g2 = evFilled > 0;
  console.log(`2. Settlement EV per filled > 0: **${evFilled >= 0 ? "+" : ""}$${evFilled.toFixed(4)}**${g2 ? " ✓" : " ✗"}`);
  if (!g2) failures.push("EV/filled not > 0");

  // Gate 3: leave-one-TTE-bucket-out survives
  let g3 = true;
  for (const b of ["6-9min", "9-12min", "12-15min"] as const) {
    const sub = records.filter((r) => r.tteBucketStr !== b && r.pnlSettlement !== null);
    if (sub.length === 0) continue;
    const subSum = sub.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
    const subEv = subSum / sub.length;
    const ok = subEv > 0;
    console.log(`3. Leave-out TTE=${b}: EV/posted = **${subEv >= 0 ? "+" : ""}$${subEv.toFixed(4)}** (n=${sub.length})${ok ? " ✓" : " ✗"}`);
    if (!ok) { g3 = false; failures.push(`leave-out TTE=${b} fails (EV=${subEv.toFixed(4)})`); }
  }

  // Gate 4: leave-one-ToD-block-out survives
  let g4 = true;
  for (const b of ["20-24Z", "00-04Z", "04-08Z"] as const) {
    const sub = records.filter((r) => r.todBlockStr !== b && r.pnlSettlement !== null);
    if (sub.length === 0) continue;
    const subSum = sub.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
    const subEv = subSum / sub.length;
    const ok = subEv > 0;
    console.log(`4. Leave-out ToD=${b}: EV/posted = **${subEv >= 0 ? "+" : ""}$${subEv.toFixed(4)}** (n=${sub.length})${ok ? " ✓" : " ✗"}`);
    if (!ok) { g4 = false; failures.push(`leave-out ToD=${b} fails (EV=${subEv.toFixed(4)})`); }
  }

  // Gate 5: top-1 market <= 25% of total signed PnL
  const totalAbsPnl = Math.abs(sumPnl);
  const byMarket = new Map<string, number>();
  for (const r of usable) byMarket.set(r.marketTicker, (byMarket.get(r.marketTicker) ?? 0) + (r.pnlSettlement ?? 0));
  let topMarket = "", topMarketShare = 0;
  for (const [mt, pnl] of byMarket.entries()) {
    if (totalAbsPnl > 0) {
      const share = Math.abs(pnl) / totalAbsPnl;
      if (share > topMarketShare) { topMarketShare = share; topMarket = mt; }
    }
  }
  const g5 = topMarketShare <= 0.25;
  console.log(`5. Top-1 market share of |PnL|: **${(topMarketShare * 100).toFixed(1)}%** (${topMarket})${g5 ? " ✓" : " ✗"}`);
  if (!g5) failures.push(`top-1 market share ${(topMarketShare * 100).toFixed(1)}% > 25%`);

  // Gate 6: top-1 2-hour wall-clock window <= 40% of |total signed PnL|
  const by2h = new Map<string, number>();
  for (const r of usable) by2h.set(r.wallClock2hKey, (by2h.get(r.wallClock2hKey) ?? 0) + (r.pnlSettlement ?? 0));
  let top2h = "", top2hShare = 0;
  for (const [k, pnl] of by2h.entries()) {
    if (totalAbsPnl > 0) {
      const share = Math.abs(pnl) / totalAbsPnl;
      if (share > top2hShare) { top2hShare = share; top2h = k; }
    }
  }
  const g6 = top2hShare <= 0.40;
  console.log(`6. Top-1 2-hour wall-clock window share: **${(top2hShare * 100).toFixed(1)}%** (${top2h})${g6 ? " ✓" : " ✗"}`);
  if (!g6) failures.push(`top-1 2h window share ${(top2hShare * 100).toFixed(1)}% > 40%`);

  // Gate 7: YES-side edge (trivially true since policy is YES-only)
  console.log(`7. YES-side edge > 0: ${evPosted > 0 ? "✓ (trivially, policy is YES-only)" : "✗"}`);

  console.log();
  if (isInSample) {
    console.log("**In-sample exploratory run — pass gates above are NOT a validation outcome.**");
    console.log("They are reported for shape only. Final go/no-go decision must wait for the");
    console.log("holdout run on fresh data, with the same gates applied there.");
  } else {
    if (failures.length === 0) {
      console.log("**HOLDOUT PASS** — all 7 gates met. Policy is validated.");
    } else {
      console.log(`**HOLDOUT FAIL** (${failures.length} gate(s) failed):`);
      for (const f of failures) console.log(`- ${f}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
