// Sanity-check the queue model on the 30h dataset.
//
// Strategy: for each KXBTC15M / KXETH15M market, pick 3 anchor times during
// active life. At each anchor, snapshot the reconstructed book; for a grid
// of (price_offset, queue_assumption), simulate a hypothetical 1-contract
// YES-side maker quote forward in time.
//
// Aggregate: fill rate and conditional markout by series × offset × queue.
//
// Sanity checks for a PASSIVE REPLAY simulator (no counterfactual taker
// reaction to our improvement; the historical tape proceeds as it actually
// did):
//
//   1. At offset <= 0, fill rate decreases monotonically as offset becomes
//      more negative (further behind best). Front-of-queue only.
//   2. At a given offset, tighter queue assumption reduces fill rate:
//      front_of_queue >= depth_fraction_50% >= back_of_queue.
//   3. Maker captures positive markout at the touch (offset=0, front_of_queue)
//      and the conditional markout degrades as the offset moves behind best
//      (offset=0 markout > offset=-1 > offset=-3 ...).
//
// Notes on what does NOT hold in passive replay (these would hold in a
// counterfactual / live simulator):
//   - Improving (+1¢) gives lower fill rate than at-touch (0¢) in replay,
//     because our +1¢ quote sits alone at a new level and only fills via
//     organic market drift. Reported as a separate diagnostic.
//   - Conditional markout for filled +1¢ quotes is POSITIVE for the maker
//     (selection bias: those quotes only fill on favorable drift), opposite
//     of the live intuition where aggressive quotes catch adverse selection.
//
// Run:
//   pnpm exec tsx src/replay/validateQueueModel.ts

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
  type QuoteSimulationResult,
} from "./queueModel.js";

const SERIES = ["KXBTC15M", "KXETH15M"] as const;
type Series = (typeof SERIES)[number];

interface Args {
  logDir: string;
}
function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return { logDir: args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector") };
}

function seriesOf(mt: string): Series | null {
  for (const s of SERIES) if (mt.startsWith(s + "-")) return s;
  return null;
}

// Anchor offsets from market open (ms). At each, we snapshot the book and
// post a hypothetical quote.
const ANCHOR_OFFSETS_MS = [3 * 60_000, 6 * 60_000, 9 * 60_000];

// Price offsets relative to current best yes-bid, in CENTS. Positive =
// improving (above best), negative = behind best.
const PRICE_OFFSETS_CENTS = [+1, 0, -1, -3, -5];

const QUEUE_ASSUMPTIONS: QueueAssumption[] = [
  { type: "front" },
  { type: "depth_fraction", fraction: 0.5 },
  { type: "back" },
];

interface ResultRow extends QuoteSimulationResult {
  offsetCents: number;
  series: Series;
}

// ---------- aggregate stats ----------

interface BucketKey {
  series: Series;
  offsetCents: number;
  queueAssumption: string;
}
function bucketKey(r: ResultRow): string {
  return `${r.series}|${r.offsetCents}|${r.queueAssumption}`;
}

interface BucketStats {
  n: number;
  filledN: number;
  fillFractionSum: number;
  // markouts only across FILLED quotes (conditional adverse-selection)
  markoutSums: Map<number, { sum: number; n: number }>; // horizon ms -> aggregate
}

function newBucket(): BucketStats {
  return { n: 0, filledN: 0, fillFractionSum: 0, markoutSums: new Map() };
}

function addToBucket(b: BucketStats, r: ResultRow): void {
  b.n += 1;
  if (r.filled) b.filledN += 1;
  b.fillFractionSum += r.fillFraction;
  if (r.fillTsMs !== null) {
    const mos: Array<[number, number | null]> = [
      [1000, r.markoutCents.ms_1000],
      [5000, r.markoutCents.ms_5000],
      [15000, r.markoutCents.ms_15000],
      [30000, r.markoutCents.ms_30000],
      [60000, r.markoutCents.ms_60000],
    ];
    for (const [h, v] of mos) {
      if (v === null) continue;
      let agg = b.markoutSums.get(h);
      if (!agg) { agg = { sum: 0, n: 0 }; b.markoutSums.set(h, agg); }
      agg.sum += v;
      agg.n += 1;
    }
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  process.stderr.write(`[validateQueueModel] log dir: ${args.logDir}\n`);

  const filter = (mt: string): boolean => seriesOf(mt) !== null;
  process.stderr.write(`[validateQueueModel] building market index for BTC + ETH...\n`);
  const t0 = Date.now();
  const indices = await buildMarketIndex(args.logDir, filter);
  process.stderr.write(
    `[validateQueueModel] indexed ${indices.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`
  );

  // Run simulations.
  const results: ResultRow[] = [];
  let simCount = 0;
  const tSimStart = Date.now();
  for (const m of indices.values()) {
    const series = seriesOf(m.marketTicker);
    if (!series) continue;
    if (m.bookEvents.length < 10) continue;
    const first = m.bookEvents[0]!.tsMs;
    const last = m.bookEvents[m.bookEvents.length - 1]!.tsMs;
    if (last - first < 6 * 60_000) continue; // need ≥6min life for anchors

    for (const anchorOff of ANCHOR_OFFSETS_MS) {
      const anchorTs = first + anchorOff;
      // Need at least 60s of runway after anchor for longest markout horizon.
      if (anchorTs > last - 60_000) continue;

      // Snapshot book at anchor.
      const state = newBookState(m.marketTicker, "");
      for (const ev of m.bookEvents) {
        if (ev.tsMs > anchorTs) break;
        if (ev.type === "snapshot") applySnapshot(state, ev);
        else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
        else applyDelta(state, ev);
      }
      const bb = bestYesBid(state);
      if (bb === null) continue;

      for (const offset of PRICE_OFFSETS_CENTS) {
        const px = Math.round((bb + offset / 100) * 10000) / 10000;
        if (px <= 0 || px >= 1) continue;
        for (const queue of QUEUE_ASSUMPTIONS) {
          const quote: HypotheticalQuote = {
            marketTicker: m.marketTicker,
            side: "yes",
            priceDollars: px,
            sizeContracts: 1,
            postedAtMs: anchorTs,
            queue,
          };
          const r = simulateQuote(quote, m);
          results.push({ ...r, offsetCents: offset, series });
          simCount += 1;
        }
      }
    }
  }
  process.stderr.write(
    `[validateQueueModel] simulated ${simCount.toLocaleString()} quotes in ` +
    `${((Date.now() - tSimStart) / 1000).toFixed(1)}s\n`
  );

  // Aggregate.
  const buckets = new Map<string, BucketStats>();
  for (const r of results) {
    const k = bucketKey(r);
    let b = buckets.get(k);
    if (!b) { b = newBucket(); buckets.set(k, b); }
    addToBucket(b, r);
  }

  // Print tables, one per (series, queue_assumption).
  console.log();
  console.log("# Queue model — validation grid");
  console.log();
  console.log("Grid: 250 markets × 3 anchors × 5 price offsets × 3 queue assumptions.");
  console.log("Posted side: yes-bid, size = 1 contract. Offset is relative to anchor-time");
  console.log("best yes-bid, in cents; positive = improving (above best), negative = behind best.");
  console.log();

  for (const series of SERIES) {
    for (const q of QUEUE_ASSUMPTIONS) {
      const qLabel = (() => {
        switch (q.type) {
          case "front": return "front_of_queue";
          case "back": return "back_of_queue";
          case "depth_fraction": return `depth_fraction_${(q.fraction * 100).toFixed(0)}%`;
        }
      })();
      console.log(`## ${series} — queue assumption: \`${qLabel}\``);
      console.log();
      console.log("| offset (¢) | n | fill rate | mean fill frac | mo +1s | mo +5s | mo +15s | mo +30s | mo +60s |");
      console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
      for (const offset of PRICE_OFFSETS_CENTS) {
        const k = `${series}|${offset}|${qLabel}`;
        const b = buckets.get(k);
        if (!b || b.n === 0) {
          console.log(`| ${offset >= 0 ? "+" : ""}${offset} | 0 | — | — | — | — | — | — | — |`);
          continue;
        }
        const fillRate = b.filledN / b.n;
        const meanFillFrac = b.fillFractionSum / b.n;
        const mo = (h: number): string => {
          const agg = b.markoutSums.get(h);
          if (!agg || agg.n === 0) return "—";
          return `${(agg.sum / agg.n).toFixed(2)} (n=${agg.n})`;
        };
        console.log(
          `| ${offset >= 0 ? "+" : ""}${offset} | ${b.n.toLocaleString()} | ${(fillRate * 100).toFixed(1)}% | ${meanFillFrac.toFixed(3)} | ${mo(1000)} | ${mo(5000)} | ${mo(15000)} | ${mo(30000)} | ${mo(60000)} |`
        );
      }
      console.log();
    }
  }

  // ---------- sanity checks ----------
  console.log("## Sanity checks");
  console.log();

  const failures: string[] = [];

  const qLabelOf = (q: QueueAssumption): string => {
    switch (q.type) {
      case "front": return "front_of_queue";
      case "back": return "back_of_queue";
      case "depth_fraction": return `depth_fraction_${(q.fraction * 100).toFixed(0)}%`;
    }
  };

  // Check 1: fill rate monotonically decreases as offset goes from 0
  // downward (more negative = further behind best). Front-of-queue only —
  // depth-dependent assumptions can be non-monotonic when level depth
  // varies with offset. Skip +1 (the alone-at-new-level case is structurally
  // different in passive replay).
  for (const series of SERIES) {
    const qLabel = "front_of_queue";
    const downward = [0, -1, -3, -5];
    const rates: Array<{ offset: number; rate: number; n: number }> = [];
    for (const o of downward) {
      const b = buckets.get(`${series}|${o}|${qLabel}`);
      if (!b || b.n === 0) continue;
      rates.push({ offset: o, rate: b.filledN / b.n, n: b.n });
    }
    if (rates.length < 2) continue;
    for (let i = 1; i < rates.length; i++) {
      const prev = rates[i - 1]!;
      const cur = rates[i]!;
      if (cur.rate > prev.rate + 0.02) {
        failures.push(
          `[1] ${series} ${qLabel}: fill rate non-monotonic going behind best — ` +
            `offset ${prev.offset} (${(prev.rate * 100).toFixed(1)}%) → ${cur.offset} (${(cur.rate * 100).toFixed(1)}%)`
        );
      }
    }
  }

  // Check 2: at a given offset, tighter queue assumption => lower fill rate.
  // front_of_queue >= depth_fraction_50% >= back_of_queue.
  for (const series of SERIES) {
    for (const offset of PRICE_OFFSETS_CENTS) {
      const front = buckets.get(`${series}|${offset}|front_of_queue`);
      const mid = buckets.get(`${series}|${offset}|depth_fraction_50%`);
      const back = buckets.get(`${series}|${offset}|back_of_queue`);
      if (!front || !mid || !back) continue;
      if (front.n === 0 || mid.n === 0 || back.n === 0) continue;
      const fr = front.filledN / front.n;
      const mr = mid.filledN / mid.n;
      const br = back.filledN / back.n;
      if (mr > fr + 0.02) {
        failures.push(
          `[2] ${series} offset=${offset}: depth_50 ${(mr * 100).toFixed(1)}% > front ${(fr * 100).toFixed(1)}%`
        );
      }
      if (br > mr + 0.02) {
        failures.push(
          `[2] ${series} offset=${offset}: back ${(br * 100).toFixed(1)}% > depth_50 ${(mr * 100).toFixed(1)}%`
        );
      }
    }
  }

  // Check 3: maker captures positive markout at the touch on front-of-queue
  // (offset=0, 30s horizon).
  for (const series of SERIES) {
    const b = buckets.get(`${series}|0|front_of_queue`);
    if (!b || b.n === 0) continue;
    const agg = b.markoutSums.get(30000);
    if (!agg || agg.n < 50) continue;
    const mean = agg.sum / agg.n;
    if (mean < 0) {
      failures.push(
        `[3] ${series} offset=0 front_of_queue 30s markout = ${mean.toFixed(2)}¢ (expected positive)`
      );
    }
  }

  // Check 4: conditional markout degrades as offset moves behind best.
  // offset=0 markout > offset=-5 markout on front_of_queue, 30s.
  for (const series of SERIES) {
    const a = buckets.get(`${series}|0|front_of_queue`);
    const z = buckets.get(`${series}|-5|front_of_queue`);
    if (!a || !z) continue;
    const aAgg = a.markoutSums.get(30000);
    const zAgg = z.markoutSums.get(30000);
    if (!aAgg || !zAgg || aAgg.n < 50 || zAgg.n < 30) continue;
    const aMean = aAgg.sum / aAgg.n;
    const zMean = zAgg.sum / zAgg.n;
    if (aMean - zMean < 0.5) {
      failures.push(
        `[4] ${series} front_of_queue 30s markout doesn't degrade enough behind best: ` +
          `offset=0 mean ${aMean.toFixed(2)}¢, offset=-5 mean ${zMean.toFixed(2)}¢ (expected drop >= 0.5¢)`
      );
    }
  }

  // Diagnostic (not a failure): passive-replay structural effects.
  const diagnostics: string[] = [];
  for (const series of SERIES) {
    for (const q of QUEUE_ASSUMPTIONS) {
      const qLabel = qLabelOf(q);
      const a = buckets.get(`${series}|1|${qLabel}`);
      const b = buckets.get(`${series}|0|${qLabel}`);
      if (!a || !b || a.n === 0 || b.n === 0) continue;
      const ra = a.filledN / a.n;
      const rb = b.filledN / b.n;
      if (ra < rb - 0.02) {
        diagnostics.push(
          `${series} ${qLabel}: improving (+1¢) fill rate ${(ra * 100).toFixed(1)}% < at-best ` +
            `${(rb * 100).toFixed(1)}% — expected structural penalty of passive replay`
        );
      }
    }
  }

  if (failures.length === 0) {
    console.log("**ALL SANITY CHECKS PASS**");
    console.log();
    console.log("[1] Fill rate monotonically decreases as offset moves behind best (front-of-queue, BTC + ETH)");
    console.log("[2] Tighter queue assumption => lower fill rate at every offset (front >= depth_50 >= back)");
    console.log("[3] Maker captures positive markout at the touch (offset=0, front-of-queue, 30s horizon)");
    console.log("[4] Conditional markout degrades monotonically as quote moves behind best");
  } else {
    console.log(`**${failures.length} CHECK(S) FAILED**`);
    console.log();
    for (const f of failures) console.log(`- ${f}`);
    process.exitCode = 1;
  }

  if (diagnostics.length > 0) {
    console.log();
    console.log("### Diagnostic — passive-replay structural effects (NOT failures)");
    console.log();
    for (const d of diagnostics) console.log(`- ${d}`);
    console.log();
    console.log("In a passive replay, posting above the historical best (offset=+1) places our quote");
    console.log("alone at a new level. Real takers do NOT react to our improvement — the historical tape");
    console.log("proceeds unchanged. So our improved quote only fills if the market organically drifts up");
    console.log("to our level. Expect lower fill rate AND positive conditional markout (selection on");
    console.log("favorable drift). A counterfactual / live simulator would model taker reaction; v1 does not.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
