// Short-horizon MARKOUT scorer for btcMakerV2's ACTUAL fills.
//
// WHY THIS EXISTS
// ---------------
// btcMakerV2.ts produces v2's exact filtered/TTL/cancel/back-of-queue fills and
// reports SETTLEMENT PnL. adverseSelectionScorer.ts reports short-horizon markout
// but on GENERIC both-side 60s-anchor quotes — not v2's fill set. Nobody had
// computed markout on the fills v2 would actually get. This does.
//
// It does NOT reimplement v2's policy (no drift risk vs the prereg lock). It
// consumes the opt-in QuoteRecord dump from:
//     pnpm exec tsx src/replay/btcMakerV2.ts --log-dir=<logs> \
//          --label=markout --dump-records=/tmp/v2-records.jsonl
// then reconstructs the SAME book (buildMarketIndex + midAtOrBefore, the shared
// single-source-of-truth primitives) to mark each fill forward.
//
// THE METRIC (v2 is yes-only: it posts a YES bid at touch → long YES on fill)
//     markout(H) = (mid_yes(fillTs + H) − touchPrice) · 100      [cents/contract]
//   = spread captured + post-fill mid drift in the maker's favor.
//   Positive = the maker is net ahead H seconds after the fill. GROSS of fees:
//   the KXBTC15M v2 prereg fee assumption is 0.00, and mixing a settlement-fee
//   haircut into a mark-to-mid number conflates two accounting objects. Fees
//   belong in the settlement/capped replay gate, not here.
//
// CAVEAT: this is a microstructure (adverse-selection persistence) gate, NOT a
// hold-to-settlement EV gate. 1s = "am I being picked off instantly", 5s = "did
// the shock persist", 30s/60s = delayed-continuation sanity. Final EV stays in
// btcMakerV2Capped / the holdout replay gate.
//
// Run:
//   pnpm exec tsx src/replay/v2Markout.ts --records=/tmp/v2-records.jsonl --log-dir=<logs>

import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildMarketIndex, midAtOrBefore, type MarketIndex } from "./queueModel.js";

const SERIES = "KXBTC15M";
function isBtcMarket(mt: string): boolean { return mt.startsWith(SERIES + "-"); }

// Horizons: 5s is the binding gate; 1s/30s/60s are sanity rails.
const HORIZONS_MS = [1000, 5000, 30000, 60000] as const;
type Horizon = (typeof HORIZONS_MS)[number];
const BINDING_H: Horizon = 5000;

// ---- verdict policy (the maker-axis analog of the §13 / 5pp Brier gate) ------------
// Provided verbatim by the operator (2026-06-07). Load-bearing, like the sigma ceiling
// and YES_MIN_EDGE thresholds in CLAUDE.md. Gross markout; BTC-only; back-of-queue.
const GATE = {
  bindingHorizon: BINDING_H,
  markout5sCiLowMinCents: 0.10,   // 5s CI-low must clear +0.10c
  railHorizonsCiLowGt0: [1000, 30000, 60000] as Horizon[], // each CI-low strictly > 0
  minFills: 5000,                 // BTC-only markout study
  minDistinctUtcDates: 3,
  maxMarketSharePnl: 0.25,        // no single 15-min contract > 25% of |markout PnL|
  maxBlock2hSharePnl: 0.40,       // no single 2h block > 40% of |markout PnL|
};

// QuoteRecord subset emitted by btcMakerV2.ts --dump-records.
interface V2Record {
  marketTicker: string;
  postedAtMs: number;
  tteMs: number;
  utcBlock: string;
  wallClock2h: string;
  touchPrice: number;
  filled: boolean;
  fillTsMs: number | null;
  fillFraction: number;
  cancelReason: string;
  settlementValue: number | null;
  pnlSettlement: number | null;
}

interface Args { records: string; logDir: string; out: string; label: string; }
function parseArgs(): Args {
  const a: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) a[m[1]!] = m[2]!;
  }
  if (!a.records) { process.stderr.write("error: --records=<jsonl> required\n"); process.exit(2); }
  return {
    records: a.records,
    logDir: a["log-dir"] ?? resolve(process.cwd(), "logs/data-collector"),
    out: a.out ?? resolve(process.cwd(), "../../analysis/markout"),
    label: a.label ?? "v2-markout",
  };
}

// ---- stats helpers ----
interface Stat { n: number; mean: number; sd: number; se: number; ciLow: number; ciHigh: number; }
function summarize(xs: number[]): Stat {
  const n = xs.length;
  if (n === 0) return { n, mean: NaN, sd: NaN, se: NaN, ciLow: NaN, ciHigh: NaN };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { n, mean, sd: NaN, se: NaN, ciLow: NaN, ciHigh: NaN };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, se, ciLow: mean - 1.96 * se, ciHigh: mean + 1.96 * se };
}
function utcDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function fmt(x: number): string { return Number.isNaN(x) ? "—" : (x >= 0 ? "+" : "") + x.toFixed(3); }

async function main(): Promise<void> {
  const args = parseArgs();
  process.stderr.write(`[v2Markout] records: ${args.records}\n`);
  process.stderr.write(`[v2Markout] log dir: ${args.logDir}\n`);

  // 1. Read v2's actual fill set.
  const recs: V2Record[] = readFileSync(args.records, "utf8")
    .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as V2Record);
  const filledRecs = recs.filter((r) => r.filled && r.fillTsMs !== null && r.fillFraction > 0
    && isBtcMarket(r.marketTicker));
  process.stderr.write(`[v2Markout] ${recs.length} records, ${filledRecs.length} BTC fills\n`);

  // 2. Reconstruct the SAME book to mark fills forward.
  const t0 = Date.now();
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(`[v2Markout] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // 3. Per-fill markout at each horizon (per-contract cents = mid_{fill+H} − touch).
  const markoutByH = new Map<Horizon, number[]>(HORIZONS_MS.map((h) => [h, []]));
  const spreadCap: number[] = [];                                   // mid_fill − touch
  const advselByH = new Map<Horizon, number[]>(HORIZONS_MS.map((h) => [h, []]));
  // concentration accounting at the binding horizon (|fillFraction · markout|)
  const absPnlByMarket = new Map<string, number>();
  const absPnlByBlock = new Map<string, number>();
  let totalAbsPnl = 0;
  const dates = new Set<string>();
  let droppedNoMid = 0;

  for (const r of filledRecs) {
    const m = idx.get(r.marketTicker) as MarketIndex | undefined;
    if (!m) { droppedNoMid++; continue; }
    const fillTs = r.fillTsMs!;
    const midFill = midAtOrBefore(m, fillTs);
    if (midFill !== null) spreadCap.push((midFill - r.touchPrice) * 100);
    dates.add(utcDate(fillTs));

    for (const H of HORIZONS_MS) {
      const midH = midAtOrBefore(m, fillTs + H);
      if (midH === null) continue;                                  // staleness guard (120s) handles end-of-life
      const markout = (midH - r.touchPrice) * 100;                  // per-contract cents
      markoutByH.get(H)!.push(markout);
      if (midFill !== null) advselByH.get(H)!.push((midH - midFill) * 100);
      if (H === GATE.bindingHorizon) {
        const absPnl = Math.abs(r.fillFraction * (midH - r.touchPrice) * 100);
        absPnlByMarket.set(r.marketTicker, (absPnlByMarket.get(r.marketTicker) ?? 0) + absPnl);
        absPnlByBlock.set(r.wallClock2h, (absPnlByBlock.get(r.wallClock2h) ?? 0) + absPnl);
        totalAbsPnl += absPnl;
      }
    }
  }

  // 4. Aggregate.
  const horizonStats = new Map<Horizon, Stat>();
  for (const H of HORIZONS_MS) horizonStats.set(H, summarize(markoutByH.get(H)!));
  const nFills = horizonStats.get(GATE.bindingHorizon)!.n;
  const maxMarketShare = totalAbsPnl > 0 ? Math.max(0, ...[...absPnlByMarket.values()].map((v) => v / totalAbsPnl)) : 0;
  const maxBlockShare = totalAbsPnl > 0 ? Math.max(0, ...[...absPnlByBlock.values()].map((v) => v / totalAbsPnl)) : 0;

  // 5. Verdict (operator's rule, verbatim).
  const checks: { name: string; pass: boolean }[] = [
    { name: `markout ${GATE.bindingHorizon / 1000}s CI-low ≥ +${GATE.markout5sCiLowMinCents}c`,
      pass: horizonStats.get(GATE.bindingHorizon)!.ciLow >= GATE.markout5sCiLowMinCents },
    ...GATE.railHorizonsCiLowGt0.map((H) => ({
      name: `markout ${H / 1000}s CI-low > 0`, pass: horizonStats.get(H)!.ciLow > 0 })),
    { name: `n_fills ≥ ${GATE.minFills}`, pass: nFills >= GATE.minFills },
    { name: `≥ ${GATE.minDistinctUtcDates} distinct UTC dates`, pass: dates.size >= GATE.minDistinctUtcDates },
    { name: `no single market > ${GATE.maxMarketSharePnl * 100}% of |markout PnL|`, pass: maxMarketShare <= GATE.maxMarketSharePnl },
    { name: `no single 2h block > ${GATE.maxBlock2hSharePnl * 100}% of |markout PnL|`, pass: maxBlockShare <= GATE.maxBlock2hSharePnl },
  ];
  const dataAdequate = nFills >= GATE.minFills && dates.size >= GATE.minDistinctUtcDates;
  const allPass = checks.every((c) => c.pass);
  const verdict = allPass ? "GO" : (!dataAdequate ? "INSUFFICIENT_DATA" : "NO-GO");

  // 6. Report.
  console.log(`\n# btcMakerV2 markout — \`${args.label}\` (BTC-only, back-of-queue, GROSS of fees)\n`);
  console.log(`- records: ${recs.length}  ·  BTC fills: ${filledRecs.length}  ·  marked: ${nFills}`
    + (droppedNoMid ? `  ·  dropped (no book): ${droppedNoMid}` : ""));
  console.log(`- distinct UTC dates: ${dates.size}  ·  markets: ${absPnlByMarket.size}  ·  2h blocks: ${absPnlByBlock.size}`);
  console.log(`- mean spread captured at fill: ${fmt(summarize(spreadCap).mean)}c\n`);
  console.log(`| horizon | n | mean markout | 95% CI | mean adv-sel |`);
  console.log(`|---|---:|---:|:--|---:|`);
  for (const H of HORIZONS_MS) {
    const s = horizonStats.get(H)!;
    const adv = summarize(advselByH.get(H)!);
    const binding = H === GATE.bindingHorizon ? " **(binding)**" : "";
    console.log(`| ${H / 1000}s${binding} | ${s.n} | ${fmt(s.mean)}c | [${fmt(s.ciLow)}, ${fmt(s.ciHigh)}] | ${fmt(adv.mean)}c |`);
  }
  console.log(`\n- max single-market share of |markout PnL|: ${(maxMarketShare * 100).toFixed(1)}%`);
  console.log(`- max single-2h-block share of |markout PnL|: ${(maxBlockShare * 100).toFixed(1)}%\n`);
  console.log(`## Verdict: ${verdict === "GO" ? "✅ GO" : verdict === "NO-GO" ? "⛔ NO-GO" : "⚠️ INSUFFICIENT_DATA"}\n`);
  for (const c of checks) console.log(`- [${c.pass ? "x" : " "}] ${c.name}`);
  console.log();

  // 7. Persist.
  mkdirSync(args.out, { recursive: true });
  const outPath = resolve(args.out, `v2_markout_${args.label}.json`);
  const json = {
    label: args.label, series: SERIES, queue: "back_of_queue", gross_of_fees: true,
    n_records: recs.length, n_btc_fills: filledRecs.length, n_marked: nFills,
    distinct_utc_dates: dates.size, n_markets: absPnlByMarket.size, n_2h_blocks: absPnlByBlock.size,
    mean_spread_captured_c: summarize(spreadCap).mean,
    horizons: Object.fromEntries(HORIZONS_MS.map((H) => {
      const s = horizonStats.get(H)!;
      return [H, { n: s.n, mean_markout_c: s.mean, se_c: s.se, ci_low_c: s.ciLow, ci_high_c: s.ciHigh,
        mean_adverse_selection_c: summarize(advselByH.get(H)!).mean }];
    })),
    max_market_share_pnl: maxMarketShare, max_block2h_share_pnl: maxBlockShare,
    gate: GATE, checks, verdict,
  };
  writeFileSync(outPath, JSON.stringify(json, null, 1));
  console.log(`wrote ${outPath}\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
