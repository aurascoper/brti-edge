// =============================================================================
// PRE-PREREG EXPLORATORY SWEEP — NOT VALIDATION, NOT A GATE.
//
// This sweeps candidate v3 filter relaxations and reports, per cell:
//   (posts, fills, fills/collection-day, markout@5s, settlement-EV/posted).
// Its ONLY purpose is to let a v3 preregistration be written against MEASURED
// fill-rate/edge tradeoffs instead of guesses. It computes NO pass/fail, and
// its numbers MUST NOT be cited as evidence about any policy's edge.
//
// It does NOT touch the prereg-locked btcMakerV2.ts. It re-encodes that policy
// in PARAMETERIZED form and proves faithfulness with a hard equivalence check:
// at v2's frozen params, on the same window, it must reproduce v2's exact
// (posted, filled) or it aborts. The frozen cell is the regression anchor.
//
// Run (needs a big heap; indexes the book once):
//   NODE_OPTIONS=--max-old-space-size=10240 \
//   pnpm exec tsx src/replay/v2FilterSweep.ts --log-dir=/tmp/v2win
// =============================================================================

import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  applyDelta, applySnapshot, applyTerminalSnapshot, bestYesAsk, bestYesBid,
  newBookState, priceToTicks, type BookEvent, type KalshiBookState,
} from "./bookReconstructor.js";
import {
  buildMarketIndex, simulateQuote, midAtOrBefore,
  type HypotheticalQuote, type MarketIndex,
} from "./queueModel.js";

const SERIES = "KXBTC15M";
function isBtc(mt: string): boolean { return mt.startsWith(SERIES + "-"); }
const ANCHOR_PERIOD_MS = 60_000, ANCHOR_RUNWAY_MS = 60_000;
const MARKOUT_H_MS = 5_000; // binding markout horizon (matches v2Markout gate)

// ---- parameterized policy (re-encoded from btcMakerV2.ts; NOT the frozen source) ----
interface PolicyParams {
  tteMinMs: number; tteMaxMs: number;
  allowedHours: Set<number>;
  moneyMin: number; moneyMax: number;       // |touch − 0.5| band
  netCap: number; perMarketCap: number;
  minSpreadTicks: number;
  ttlMs: number; spreadWidenTicks: number;
  cancelSpreadWiden: boolean; cancelQueueDeter: boolean;
}
// EXACTLY v2's frozen constants — the equivalence anchor (must reproduce 194/29).
const V2_FROZEN: PolicyParams = {
  tteMinMs: 360_000, tteMaxMs: 840_000,
  allowedHours: new Set([0, 1, 2, 3, 4, 5, 6, 7]),
  moneyMin: 0.15, moneyMax: 0.40,
  netCap: 2, perMarketCap: 1,
  minSpreadTicks: 1,
  ttlMs: 75_000, spreadWidenTicks: 1,
  cancelSpreadWiden: true, cancelQueueDeter: true,
};

function ticks(p: number): number { return priceToTicks(p.toFixed(4)); }
function applyAny(s: KalshiBookState, ev: BookEvent): void {
  if (ev.type === "snapshot") applySnapshot(s, ev);
  else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(s, ev);
  else applyDelta(s, ev);
}
function inferSettlement(midTs: number[], midYes: number[], lastTradeTs: number, lastTradeYes: number): number | null {
  const i = midYes.length - 1;
  const lastMidTs = i >= 0 ? midTs[i]! : -1;
  const lastMid = i >= 0 ? midYes[i]! : NaN;
  let v: number;
  if (lastTradeTs > lastMidTs && Number.isFinite(lastTradeYes)) v = lastTradeYes;
  else if (!Number.isNaN(lastMid)) v = lastMid;
  else return null;
  if (v >= 0.97) return 1.0;
  if (v <= 0.03) return 0.0;
  return v;
}
// First cancel-trigger between (postedAt, stopTs], or null. (Mirrors findCancelTrigger.)
function cancelTrigger(m: MarketIndex, postedAt: number, stopTs: number, postSpreadTicks: number, postBidTicks: number, p: PolicyParams): number | null {
  const s = newBookState(m.marketTicker, "");
  let i = 0;
  for (; i < m.bookEvents.length; i++) { const ev = m.bookEvents[i]!; if (ev.tsMs > postedAt) break; applyAny(s, ev); }
  for (; i < m.bookEvents.length; i++) {
    const ev = m.bookEvents[i]!; if (ev.tsMs > stopTs) break; applyAny(s, ev);
    const cb = bestYesBid(s), ca = bestYesAsk(s);
    if (p.cancelQueueDeter && cb !== null && ticks(cb) > postBidTicks) return ev.tsMs;
    if (p.cancelSpreadWiden && cb !== null && ca !== null && ticks(ca - cb) > postSpreadTicks + p.spreadWidenTicks) return ev.tsMs;
  }
  return null;
}
// Returns fill outcome under the parameterized v2 wrapper.
function simV2(m: MarketIndex, postedAt: number, price: number, postSpreadTicks: number, p: PolicyParams): { filled: boolean; fillTsMs: number | null; fillFraction: number } {
  const quote: HypotheticalQuote = { marketTicker: m.marketTicker, side: "yes", priceDollars: price, sizeContracts: 1, postedAtMs: postedAt, queue: { type: "back" } };
  const r = simulateQuote(quote, m, p.ttlMs);
  const postBidTicks = ticks(price);
  if (r.filled && r.fillTsMs !== null) {
    const trig = cancelTrigger(m, postedAt, r.fillTsMs, postSpreadTicks, postBidTicks, p);
    if (trig !== null && trig < r.fillTsMs) return { filled: false, fillTsMs: null, fillFraction: 0 };
    return { filled: true, fillTsMs: r.fillTsMs, fillFraction: r.fillFraction };
  }
  return { filled: false, fillTsMs: null, fillFraction: 0 };
}

interface Anchor { mt: string; tsMs: number; tteMs: number; }
interface CellResult {
  posted: number; filled: number; fillsPerCollDay: number;
  markout5Mean: number; markout5N: number; evPostedC: number; daysTo5k: number;
}

function runCell(idx: Map<string, MarketIndex>, anchors: Anchor[], settle: Map<string, number | null>, lastTs: Map<string, number>, numDates: number, p: PolicyParams): CellResult {
  const openPos: { mt: string; settleAt: number }[] = [];
  const alive: { mt: string; until: number }[] = [];
  let posted = 0, filled = 0;
  let pnlSum = 0, pnlN = 0;
  const markouts: number[] = [];

  for (const a of anchors) {
    // prune causal state
    for (let i = openPos.length - 1; i >= 0; i--) if (openPos[i]!.settleAt <= a.tsMs) openPos.splice(i, 1);
    for (let i = alive.length - 1; i >= 0; i--) if (alive[i]!.until <= a.tsMs) alive.splice(i, 1);

    // filters (same order as applyPrePostFilters)
    if (a.tteMs < p.tteMinMs || a.tteMs > p.tteMaxMs) continue;
    if (!p.allowedHours.has(new Date(a.tsMs).getUTCHours())) continue;
    const m = idx.get(a.mt)!;
    const s = newBookState(a.mt, "");
    for (const ev of m.bookEvents) { if (ev.tsMs > a.tsMs) break; applyAny(s, ev); }
    const yb = bestYesBid(s); if (yb === null) continue;
    const mny = Math.abs(yb - 0.5); if (mny < p.moneyMin || mny > p.moneyMax) continue;
    const ya = bestYesAsk(s); if (ya === null) continue;
    const spreadTicks = ticks(ya - yb); if (spreadTicks < p.minSpreadTicks) continue;
    if (openPos.length >= p.netCap) continue;                                  // net directional cap
    const perMkt = alive.filter((x) => x.mt === a.mt).length + openPos.filter((x) => x.mt === a.mt).length;
    if (perMkt >= p.perMarketCap) continue;                                    // per-market cap

    // post
    posted += 1;
    const r = simV2(m, a.tsMs, yb, spreadTicks, p);
    alive.push({ mt: a.mt, until: a.tsMs + p.ttlMs });

    const sv = settle.get(a.mt) ?? null;
    if (r.filled) {
      filled += 1;
      if (sv !== null) { pnlSum += (sv - yb) * r.fillFraction; pnlN += 1; }
      const midH = midAtOrBefore(m, r.fillTsMs! + MARKOUT_H_MS);
      if (midH !== null) markouts.push((midH - yb) * 100);
      openPos.push({ mt: a.mt, settleAt: lastTs.get(a.mt) ?? r.fillTsMs! });
    } else if (sv !== null) { pnlN += 1; /* unfilled pnl = 0 */ }
  }

  const markout5Mean = markouts.length ? markouts.reduce((s, x) => s + x, 0) / markouts.length : NaN;
  const fillsPerCollDay = filled / numDates;
  return {
    posted, filled, fillsPerCollDay,
    markout5Mean, markout5N: markouts.length,
    evPostedC: pnlN ? (pnlSum / pnlN) * 100 : NaN,
    daysTo5k: fillsPerCollDay > 0 ? 5000 / fillsPerCollDay : Infinity,
  };
}

function fmt(x: number, d = 2): string { return Number.isNaN(x) ? "—" : (x >= 0 ? "+" : "") + x.toFixed(d); }

async function main(): Promise<void> {
  const a: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) { const m = arg.match(/^--([^=]+)=(.*)$/); if (m) a[m[1]!] = m[2]!; }
  const logDir = a["log-dir"] ?? resolve(process.cwd(), "logs/data-collector");
  const out = a.out ?? resolve(process.cwd(), "../../analysis/markout");
  process.stderr.write(`[v2FilterSweep] PRE-PREREG EXPLORATORY — not a gate. log dir: ${logDir}\n`);

  const t0 = Date.now();
  const idx = await buildMarketIndex(logDir, isBtc);
  process.stderr.write(`[v2FilterSweep] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // anchors + settlement + lastTs (all param-independent — built once)
  const anchors: Anchor[] = [];
  const settle = new Map<string, number | null>();
  const lastTs = new Map<string, number>();
  const dateSet = new Set<string>();
  for (const m of idx.values()) {
    const be = m.bookEvents; if (be.length < 10) continue;
    const first = be[0]!.tsMs, last = be[be.length - 1]!.tsMs;
    lastTs.set(m.marketTicker, last);
    const lt = m.trades[m.trades.length - 1];
    settle.set(m.marketTicker, inferSettlement(m.midTs, m.midYes, lt ? lt.tsMs : -1, lt ? lt.yesPrice : NaN));
    if (last - first < 2 * ANCHOR_PERIOD_MS) continue;
    const lastAnchor = last - ANCHOR_RUNWAY_MS;
    for (let ts = first + ANCHOR_PERIOD_MS; ts <= lastAnchor; ts += ANCHOR_PERIOD_MS) {
      anchors.push({ mt: m.marketTicker, tsMs: ts, tteMs: last - ts });
      dateSet.add(new Date(ts).toISOString().slice(0, 10));
    }
  }
  anchors.sort((x, y) => x.tsMs - y.tsMs);
  const numDates = dateSet.size;
  process.stderr.write(`[v2FilterSweep] ${anchors.length} anchors across ${numDates} dates\n`);

  // ---- EQUIVALENCE CHECK (regression vs the frozen v2 source of truth) ----
  const base = runCell(idx, anchors, settle, lastTs, numDates, V2_FROZEN);
  const EXPECT = { posted: 194, filled: 29 };
  const ok = base.posted === EXPECT.posted && base.filled === EXPECT.filled;
  process.stderr.write(`[v2FilterSweep] equivalence @v2_frozen: posted=${base.posted} filled=${base.filled} (expect ${EXPECT.posted}/${EXPECT.filled}) → ${ok ? "MATCH" : "MISMATCH"}\n`);
  if (!ok) {
    process.stderr.write(`[v2FilterSweep] ABORT: parameterized policy does not reproduce frozen v2 on this window. Fix replication before trusting the sweep.\n`);
    process.exit(3);
  }

  // ---- SWEEP: one lever at a time + stacked safe + dangerous fill-rate lever ----
  const P = (over: Partial<PolicyParams>): PolicyParams => ({ ...V2_FROZEN, ...over });
  const cells: { name: string; risk: string; p: PolicyParams }[] = [
    { name: "v2_frozen (anchor)", risk: "—", p: V2_FROZEN },
    { name: "moneyness band 0.15→0.10", risk: "med", p: P({ moneyMin: 0.10 }) },
    { name: "moneyness band 0.15→0.05", risk: "med", p: P({ moneyMin: 0.05 }) },
    { name: "TTE min 6→3 min", risk: "med", p: P({ tteMinMs: 180_000 }) },
    { name: "TTE [6,14]→[2,15] min", risk: "med", p: P({ tteMinMs: 120_000, tteMaxMs: 900_000 }) },
    { name: "per-market cap 1→2 (net 2→4)", risk: "low", p: P({ perMarketCap: 2, netCap: 4 }) },
    { name: "per-market cap 1→3 (net 2→6)", risk: "low", p: P({ perMarketCap: 3, netCap: 6 }) },
    { name: "STACKED safe (mny0.10+TTE3+cap3/6)", risk: "low-med", p: P({ moneyMin: 0.10, tteMinMs: 180_000, perMarketCap: 3, netCap: 6 }) },
    { name: "spread-widen 1→2 tick [FILL-RATE]", risk: "HIGH", p: P({ spreadWidenTicks: 2 }) },
    { name: "spread-widen 1→3 tick [FILL-RATE]", risk: "HIGH", p: P({ spreadWidenTicks: 3 }) },
  ];

  const rows = cells.map((c) => ({ ...c, r: c.name === "v2_frozen (anchor)" ? base : runCell(idx, anchors, settle, lastTs, numDates, c.p) }));

  console.log(`\n# v2 filter sweep — PRE-PREREG EXPLORATORY (NOT a gate)\n`);
  console.log(`- window: ${numDates} UTC dates, ${anchors.length} candidate anchors (hours as staged — relaxing hours needs full-day data)`);
  console.log(`- equivalence @v2_frozen: posted ${base.posted} / filled ${base.filled} → MATCH\n`);
  console.log(`| cell | risk | posted | filled | fills/coll-day | days→5k | markout@5s | EV/posted |`);
  console.log(`|---|:--|---:|---:|---:|---:|---:|---:|`);
  for (const { name, risk, r } of rows) {
    const d2k = Number.isFinite(r.daysTo5k) ? Math.round(r.daysTo5k).toString() : "∞";
    console.log(`| ${name} | ${risk} | ${r.posted} | ${r.filled} | ${r.fillsPerCollDay.toFixed(1)} | ${d2k} | ${fmt(r.markout5Mean)}¢ (n=${r.markout5N}) | ${fmt(r.evPostedC)}¢ |`);
  }
  console.log(`\n> Numbers are diagnostic only. markout@5s and EV are noisy at these n; they shape a v3 prereg, they do not validate one.`);
  console.log(`> Hours lever not swept here (staged window is a fixed UTC-hour slice). Opening 00–08Z→24h is ~3× candidates, estimated separately.\n`);

  mkdirSync(out, { recursive: true });
  const outPath = resolve(out, `v2_filter_sweep.json`);
  writeFileSync(outPath, JSON.stringify({
    note: "PRE-PREREG EXPLORATORY. Not a gate. Do not cite as edge evidence.",
    numDates, nAnchors: anchors.length, equivalence: { posted: base.posted, filled: base.filled, match: ok },
    cells: rows.map(({ name, risk, p, r }) => ({ name, risk, params: { ...p, allowedHours: [...p.allowedHours] }, ...r })),
  }, null, 1));
  console.log(`wrote ${outPath}\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
