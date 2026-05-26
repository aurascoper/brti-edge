// Data-adequacy report generator.
//
// Reads the gzipped JSONL files written by the collector over a window
// (default: last 24h, override via --since=ISO and --until=ISO) and prints
// the 8 user-specified adequacy metrics:
//
//   1. events per market
//   2. depth levels observed
//   3. trade prints observed
//   4. average quote update cadence
//   5. book reconstruction sanity checks
//   6. storage/day estimate
//   7. whether trade direction/aggressor side is actually present
//   8. whether enough data exists to estimate adverse selection
//
// READ-ONLY. Does not write back to the collector log dir. Output goes to
// stdout as Markdown.
//
// Run:
//   pnpm run report
//   pnpm run report -- --since=2026-05-25T00:00:00Z --until=2026-05-26T00:00:00Z
//   pnpm run report -- --log-dir=/path/to/logs/data-collector

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

interface Args {
  since: Date;
  until: Date;
  logDir: string;
}

function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  const until = args.until ? new Date(args.until) : new Date();
  const since = args.since ? new Date(args.since) : new Date(until.getTime() - 24 * 3_600_000);
  const logDir = args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector");
  return { since, until, logDir };
}

const CHANNELS = ["orderbook-snapshots", "orderbook-deltas", "trades", "tickers", "lifecycle"];

function utcHourString(d: Date): string {
  return d.toISOString().slice(0, 13);
}

function* hoursBetween(since: Date, until: Date): Generator<string> {
  const a = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate(), since.getUTCHours()));
  const b = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate(), until.getUTCHours()));
  for (let t = a.getTime(); t <= b.getTime(); t += 3_600_000) {
    yield utcHourString(new Date(t));
  }
}

async function* readGzLines(path: string): AsyncGenerator<string> {
  // Tolerate truncated gzip files (e.g. the active current-hour file while
  // the collector is still running). zlib emits Z_BUF_ERROR when it hits a
  // partial member; we swallow the error after yielding whatever lines
  // were successfully decompressed.
  const gz = createReadStream(path).pipe(createGunzip());
  gz.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "Z_BUF_ERROR" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      // Re-surface non-truncation errors so genuine corruption is visible.
      process.stderr.write(`[adequacyReport] decompress warning ${path}: ${err.message}\n`);
    }
  });
  const rl = createInterface({ input: gz, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "Z_BUF_ERROR" && code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
    // truncated — partial yields already returned
  }
}

interface FileInfo {
  channel: string;
  hour: string;
  path: string;
  bytes: number;
}

function discoverFiles(args: Args): FileInfo[] {
  let files: string[] = [];
  try {
    files = readdirSync(args.logDir);
  } catch {
    console.error(`# log dir not found: ${args.logDir}`);
    return [];
  }
  const hours = new Set<string>();
  for (const h of hoursBetween(args.since, args.until)) hours.add(h);
  const out: FileInfo[] = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl.gz")) continue;
    const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl\.gz$/);
    if (!m) continue;
    const channel = m[1]!;
    const hour = m[2]!;
    if (!hours.has(hour)) continue;
    if (!CHANNELS.includes(channel)) continue;
    const path = resolve(args.logDir, f);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      // skip
    }
    out.push({ channel, hour, path, bytes });
  }
  return out.sort((a, b) => (a.hour + a.channel).localeCompare(b.hour + b.channel));
}

interface Metrics {
  filesByChannel: Record<string, number>;
  bytesByChannel: Record<string, number>;
  linesByChannel: Record<string, number>;
  tickersInSnapshots: Set<string>;
  tickersInDeltas: Set<string>;
  tickersInTrades: Set<string>;
  eventsByTicker: Record<string, { snapshots: number; deltas: number; trades: number }>;
  // For depth-level histogram from snapshots
  depthLevelsHistogram: Record<string, number>; // bin index → count
  maxDepthLevelsSeen: number;
  // Trade direction discovery
  tradeRaw_sample: unknown[];
  tradeFieldsObserved: Record<string, number>;
  tradesWithTakerSide: number;
  totalTrades: number;
  // Quote update cadence: ts_diff between consecutive deltas per ticker
  // (truncated sample to keep memory bounded)
  deltaInterArrivals: Map<string, number[]>;
  // Snapshot examples (first per channel) for schema inspection
  snapshotSample: unknown | null;
  deltaSample: unknown | null;
  tickerSample: unknown | null;
  windowStart: number | null;
  windowEnd: number | null;
}

function emptyMetrics(): Metrics {
  return {
    filesByChannel: {},
    bytesByChannel: {},
    linesByChannel: {},
    tickersInSnapshots: new Set(),
    tickersInDeltas: new Set(),
    tickersInTrades: new Set(),
    eventsByTicker: {},
    depthLevelsHistogram: {},
    maxDepthLevelsSeen: 0,
    tradeRaw_sample: [],
    tradeFieldsObserved: {},
    tradesWithTakerSide: 0,
    totalTrades: 0,
    deltaInterArrivals: new Map(),
    snapshotSample: null,
    deltaSample: null,
    tickerSample: null,
    windowStart: null,
    windowEnd: null,
  };
}

function tickerFromMsg(raw: any): string | undefined {
  // Kalshi WS payloads vary: { msg: { market_ticker: "...", ... } }
  return raw?.msg?.market_ticker ?? raw?.market_ticker ?? undefined;
}

function bucketDepth(n: number): string {
  if (n === 0) return "0";
  if (n <= 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 5) return "4-5";
  if (n <= 10) return "6-10";
  if (n <= 20) return "11-20";
  return "20+";
}

async function processFile(info: FileInfo, m: Metrics): Promise<void> {
  m.filesByChannel[info.channel] = (m.filesByChannel[info.channel] ?? 0) + 1;
  m.bytesByChannel[info.channel] = (m.bytesByChannel[info.channel] ?? 0) + info.bytes;
  for await (const line of readGzLines(info.path)) {
    if (!line) continue;
    let obj: { recv_ts_ms?: number; raw?: any };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    m.linesByChannel[info.channel] = (m.linesByChannel[info.channel] ?? 0) + 1;
    const ts = typeof obj.recv_ts_ms === "number" ? obj.recv_ts_ms : null;
    if (ts !== null) {
      if (m.windowStart === null || ts < m.windowStart) m.windowStart = ts;
      if (m.windowEnd === null || ts > m.windowEnd) m.windowEnd = ts;
    }
    const raw = obj.raw;
    const ticker = tickerFromMsg(raw);

    if (info.channel === "orderbook-snapshots") {
      if (!m.snapshotSample) m.snapshotSample = raw;
      if (ticker) {
        m.tickersInSnapshots.add(ticker);
        const e = (m.eventsByTicker[ticker] ??= { snapshots: 0, deltas: 0, trades: 0 });
        e.snapshots += 1;
      }
      // Count depth levels in the snapshot. Kalshi v2 ws sends:
      //   msg.yes_dollars_fp -> [[price_str, size_fp], ...]
      //   msg.no_dollars_fp  -> [[price_str, size_fp], ...]
      // (Older docs sometimes show msg.yes / msg.no — kept as fallback.)
      const yes = raw?.msg?.yes_dollars_fp ?? raw?.msg?.yes;
      const no = raw?.msg?.no_dollars_fp ?? raw?.msg?.no;
      const nLevels = (Array.isArray(yes) ? yes.length : 0) + (Array.isArray(no) ? no.length : 0);
      const bucket = bucketDepth(nLevels);
      m.depthLevelsHistogram[bucket] = (m.depthLevelsHistogram[bucket] ?? 0) + 1;
      if (nLevels > m.maxDepthLevelsSeen) m.maxDepthLevelsSeen = nLevels;
    } else if (info.channel === "orderbook-deltas") {
      if (!m.deltaSample) m.deltaSample = raw;
      if (ticker) {
        m.tickersInDeltas.add(ticker);
        const e = (m.eventsByTicker[ticker] ??= { snapshots: 0, deltas: 0, trades: 0 });
        e.deltas += 1;
        if (ts !== null) {
          const arr = m.deltaInterArrivals.get(ticker) ?? [];
          if (arr.length > 0) {
            const prev = arr[arr.length - 1]!;
            const dt = ts - prev;
            if (dt > 0 && dt < 600_000) {
              // Track inter-arrivals up to last 500 per ticker to bound memory
              if (arr.length < 1000) arr.push(ts);
              else { arr.shift(); arr.push(ts); }
            }
          } else {
            arr.push(ts);
          }
          m.deltaInterArrivals.set(ticker, arr);
        }
      }
    } else if (info.channel === "trades") {
      m.totalTrades += 1;
      if (m.tradeRaw_sample.length < 5) m.tradeRaw_sample.push(raw);
      if (raw?.msg) {
        for (const k of Object.keys(raw.msg as object)) {
          m.tradeFieldsObserved[k] = (m.tradeFieldsObserved[k] ?? 0) + 1;
        }
        // Kalshi trade payload typically includes "taker_side" ("yes"|"no")
        // indicating which side was the aggressor.
        if (raw.msg.taker_side === "yes" || raw.msg.taker_side === "no") {
          m.tradesWithTakerSide += 1;
        }
      }
      if (ticker) {
        m.tickersInTrades.add(ticker);
        const e = (m.eventsByTicker[ticker] ??= { snapshots: 0, deltas: 0, trades: 0 });
        e.trades += 1;
      }
    } else if (info.channel === "tickers") {
      if (!m.tickerSample) m.tickerSample = raw;
    }
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  return `${((100 * num) / den).toFixed(1)}%`;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const sorted = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("# Kalshi Data-Collector Adequacy Report\n");
  console.log(`- window: \`${args.since.toISOString()}\` → \`${args.until.toISOString()}\``);
  console.log(`- log dir: \`${args.logDir}\``);
  const files = discoverFiles(args);
  console.log(`- files matched: ${files.length}`);
  if (files.length === 0) {
    console.log("\n**No files found in the window. Did the collector run?**");
    return;
  }

  const m = emptyMetrics();
  for (const f of files) {
    await processFile(f, m);
  }

  const allTickers = new Set<string>([...m.tickersInSnapshots, ...m.tickersInDeltas, ...m.tickersInTrades]);
  const windowMs = m.windowEnd !== null && m.windowStart !== null ? m.windowEnd - m.windowStart : 0;
  const windowH = windowMs / 3_600_000;

  console.log(`- observed window: ${(windowH).toFixed(2)}h\n`);

  // ---- 1. events per market ----
  console.log("## 1. Events per market\n");
  const perMarketRows = Object.entries(m.eventsByTicker).map(([t, v]) => ({
    ticker: t,
    snapshots: v.snapshots,
    deltas: v.deltas,
    trades: v.trades,
    total: v.snapshots + v.deltas + v.trades,
  })).sort((a, b) => b.total - a.total);

  // Group by series
  const perSeries: Record<string, { markets: number; snapshots: number; deltas: number; trades: number }> = {};
  for (const r of perMarketRows) {
    const series = r.ticker.split("-")[0]!;
    const e = (perSeries[series] ??= { markets: 0, snapshots: 0, deltas: 0, trades: 0 });
    e.markets += 1;
    e.snapshots += r.snapshots;
    e.deltas += r.deltas;
    e.trades += r.trades;
  }
  console.log("| series | markets | snapshots | deltas | trades | total |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [series, v] of Object.entries(perSeries).sort()) {
    console.log(`| ${series} | ${v.markets} | ${v.snapshots} | ${v.deltas} | ${v.trades} | ${v.snapshots + v.deltas + v.trades} |`);
  }
  console.log(`\n- distinct markets observed: ${allTickers.size}`);
  console.log(`- markets with at least one trade: ${m.tickersInTrades.size}`);
  console.log(`- markets with at least one delta: ${m.tickersInDeltas.size}`);

  // ---- 2. depth levels observed ----
  console.log("\n## 2. Depth levels observed (from orderbook snapshots)\n");
  console.log(`- max depth levels (yes + no, single snapshot): **${m.maxDepthLevelsSeen}**`);
  console.log("- histogram (yes + no combined per snapshot):\n");
  console.log("| bucket | count |");
  console.log("|---|---:|");
  for (const [b, c] of Object.entries(m.depthLevelsHistogram).sort()) {
    console.log(`| ${b} | ${c} |`);
  }

  // ---- 3. trade prints ----
  console.log("\n## 3. Trade prints observed\n");
  console.log(`- total trade events: **${m.totalTrades}**`);
  console.log(`- across ${m.tickersInTrades.size} markets`);
  if (windowH > 0) console.log(`- rate: ${(m.totalTrades / windowH).toFixed(1)} trades/hour`);
  console.log("- fields observed on trade messages:\n");
  console.log("| field | count |");
  console.log("|---|---:|");
  for (const [k, c] of Object.entries(m.tradeFieldsObserved).sort((a, b) => b[1] - a[1])) {
    console.log(`| \`${k}\` | ${c} |`);
  }

  // ---- 4. average quote update cadence ----
  console.log("\n## 4. Quote-update cadence (delta inter-arrival, per ticker)\n");
  // Combine all inter-arrivals from all tickers
  const allDt: number[] = [];
  for (const arr of m.deltaInterArrivals.values()) {
    for (let i = 1; i < arr.length; i++) {
      allDt.push(arr[i]! - arr[i - 1]!);
    }
  }
  if (allDt.length === 0) {
    console.log("- no delta inter-arrivals (no deltas observed)");
  } else {
    console.log(`- sample size: ${allDt.length}`);
    console.log(`- p50: ${quantile(allDt, 0.5).toFixed(0)} ms`);
    console.log(`- p90: ${quantile(allDt, 0.9).toFixed(0)} ms`);
    console.log(`- p99: ${quantile(allDt, 0.99).toFixed(0)} ms`);
    console.log(`- mean: ${(allDt.reduce((a, b) => a + b, 0) / allDt.length).toFixed(0)} ms`);
  }

  // ---- 5. book reconstruction sanity ----
  console.log("\n## 5. Book reconstruction sanity\n");
  // Light sanity only: do we have snapshots AND deltas for the same tickers?
  // Heavy reconstruction (replay deltas, compare against later snapshot) is
  // deferred to the harness — too expensive for the adequacy report.
  const haveBoth = new Set([...m.tickersInSnapshots].filter((t) => m.tickersInDeltas.has(t)));
  console.log(`- tickers with both snapshots and deltas: ${haveBoth.size} / ${m.tickersInSnapshots.size}`);
  console.log(`- if low: orderbook_delta subscription may be silently failing`);
  if (m.snapshotSample) {
    console.log("\n- example snapshot payload (truncated to 800 chars):\n");
    console.log("```json");
    console.log(JSON.stringify(m.snapshotSample, null, 2).slice(0, 800));
    console.log("```");
  }
  if (m.deltaSample) {
    console.log("\n- example delta payload (truncated to 800 chars):\n");
    console.log("```json");
    console.log(JSON.stringify(m.deltaSample, null, 2).slice(0, 800));
    console.log("```");
  }

  // ---- 6. storage/day estimate ----
  console.log("\n## 6. Storage per day (gzipped)\n");
  let totalBytes = 0;
  console.log("| channel | files | bytes |");
  console.log("|---|---:|---:|");
  for (const c of CHANNELS) {
    const b = m.bytesByChannel[c] ?? 0;
    const f = m.filesByChannel[c] ?? 0;
    totalBytes += b;
    console.log(`| ${c} | ${f} | ${fmtBytes(b)} |`);
  }
  console.log(`\n- total bytes in window: ${fmtBytes(totalBytes)}`);
  if (windowH > 0) {
    const perDay = (totalBytes * 24) / windowH;
    console.log(`- extrapolated to 24h: **${fmtBytes(perDay)}/day**`);
    const per30d = perDay * 30;
    console.log(`- extrapolated to 30d: ${fmtBytes(per30d)}`);
  }

  // ---- 7. trade direction / aggressor side ----
  console.log("\n## 7. Trade direction / aggressor side\n");
  console.log(`- trades with non-null \`taker_side\` (yes/no): ${m.tradesWithTakerSide} / ${m.totalTrades} (${pct(m.tradesWithTakerSide, m.totalTrades)})`);
  if (m.tradeRaw_sample.length > 0) {
    console.log("\n- example trade payloads:\n");
    for (const t of m.tradeRaw_sample) {
      console.log("```json");
      console.log(JSON.stringify(t, null, 2).slice(0, 600));
      console.log("```");
    }
  }
  console.log(
    `\n- Dubach 2026 (arxiv 2604.24366v2) shows that inferring direction from quote moves alone is only ~59% accurate on prediction markets.`,
  );
  console.log(
    `- If \`taker_side\` is present on ≥ 95% of trades, we have ground-truth direction and adverse-selection estimation is well-posed.`,
  );

  // ---- 8. AS estimability ----
  console.log("\n## 8. Enough data to estimate adverse selection?\n");
  const minTradesPerSeriesForAS = 1000; // rough heuristic
  console.log("**Rules of thumb**:");
  console.log("- need ≥ 1,000 directed trades per series to fit even a coarse AS model");
  console.log("- need delta cadence p50 ≤ 1s for post-fill markout at 1-5s horizons");
  console.log("- need depth levels ≥ 3 per side for queue-position simulation");
  console.log("\n**Per-series trade counts**:");
  console.log("| series | trades | enough? (≥1000 in 24h) |");
  console.log("|---|---:|---|");
  const perSeriesTrades: Record<string, number> = {};
  for (const t of m.tickersInTrades) {
    const s = t.split("-")[0]!;
    perSeriesTrades[s] = (perSeriesTrades[s] ?? 0) + (m.eventsByTicker[t]?.trades ?? 0);
  }
  for (const [series, n] of Object.entries(perSeriesTrades).sort()) {
    const enough = n >= minTradesPerSeriesForAS;
    console.log(`| ${series} | ${n} | ${enough ? "✓" : "✗"} |`);
  }

  // Final verdict
  console.log("\n## Verdict\n");
  const haveTrades = m.totalTrades > 100;
  const haveDeltas = (m.linesByChannel["orderbook-deltas"] ?? 0) > 100;
  const haveSnapshots = (m.linesByChannel["orderbook-snapshots"] ?? 0) > 0;
  const haveDirection = m.totalTrades > 0 && m.tradesWithTakerSide / m.totalTrades >= 0.95;
  const haveDepth = m.maxDepthLevelsSeen >= 3;
  const allPass = haveTrades && haveDeltas && haveSnapshots && haveDirection && haveDepth;

  console.log("| check | status |");
  console.log("|---|---|");
  console.log(`| snapshots received | ${haveSnapshots ? "✓" : "✗"} |`);
  console.log(`| deltas received | ${haveDeltas ? "✓" : "✗"} |`);
  console.log(`| trades received | ${haveTrades ? "✓" : "✗"} |`);
  console.log(`| trade direction available (≥95%) | ${haveDirection ? "✓" : "✗"} |`);
  console.log(`| depth ≥ 3 levels | ${haveDepth ? "✓" : "✗"} |`);
  console.log(`\n**Adequate for replay harness work?** ${allPass ? "YES" : "NO — see failed checks above"}`);
}

main().catch((err) => {
  console.error("[adequacyReport] fatal:", err);
  process.exit(1);
});
