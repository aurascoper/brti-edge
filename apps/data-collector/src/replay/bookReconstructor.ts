// Kalshi orderbook reconstructor.
//
// Consumes the 30h dataset (orderbook-snapshots-*.jsonl.gz + orderbook-deltas-*.jsonl.gz)
// and rebuilds per-market book state keyed by (market_ticker, ts_ms).
//
// Kalshi semantics (verified against the 2026-05-25 30h capture):
//
//   - orderbook_snapshot with `yes_dollars_fp` + `no_dollars_fp` arrays
//       = full book delivered on initial subscribe and on WS reconnect resync.
//       The arrays are BIDS ONLY — `yes_dollars_fp` is the yes-side bid book,
//       `no_dollars_fp` is the no-side bid book. Each entry is
//       `[price_dollars_string, size_string]`. No explicit asks.
//   - orderbook_snapshot with only {market_ticker, market_id} (header-only)
//       = book terminated. Fired AFTER the close-time deltas, signals the
//       market has settled. We mark the book as `terminated` and stop
//       applying further events to it.
//   - orderbook_delta {side, price_dollars, delta_fp}
//       = signed change on one bid side at a single price level. Apply by
//       new_size = current_size + delta_fp; remove the level when new_size
//       <= 0 (with float tolerance).
//
// Asks are derived via no-arb: bestYesAsk = 1 - bestNoBid. Mid_yes uses the
// derived ask. This matches packages/kalshi-client/src/client.ts:parseOrderbook.
//
// Per-channel WS sequence counter (sid=1) is intentionally ignored for book
// reconstruction. Sequence resets at WS reconnects are followed by a Shape-A
// snapshot which reseats the book. Forward gaps cluster on 15-min rollovers
// and are seq-advances for unsubscribed markets — see
// docs/research/kalshi-data-collector-30h-2026-05-26.md.

import { createReadStream, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

// Prices are 4-decimal dollars ("0.0010" .. "0.9990"). Store as integer
// ten-thousandths to keep Map keys exact-equality safe.
export const priceToTicks = (s: string): number => Math.round(parseFloat(s) * 10_000);
export const ticksToDollars = (t: number): number => t / 10_000;
const sizeToNum = (s: string): number => parseFloat(s);

export type Side = "yes" | "no";

export interface KalshiBookState {
  marketTicker: string;
  marketId: string;
  tsMs: number;       // ts of the last applied event
  recvTsMs: number;   // local recv ts of the last applied event
  yesLevels: Map<number, number>; // priceTicks -> size (yes-side bids)
  noLevels: Map<number, number>;  // priceTicks -> size (no-side bids)
  initialized: boolean; // true after first snapshot-with-levels
  terminated: boolean;  // true after header-only snapshot
  // Diagnostic counters
  deltasApplied: number;
  snapshotsApplied: number;
  deltasSkipped: number; // applied before init or after terminate
}

export type BookEvent =
  | {
      type: "snapshot";
      marketTicker: string;
      marketId: string;
      tsMs: number;
      recvTsMs: number;
      yesLevels: Array<[string, string]>;
      noLevels: Array<[string, string]>;
    }
  | {
      type: "snapshot_terminal";
      marketTicker: string;
      marketId: string;
      tsMs: number;
      recvTsMs: number;
    }
  | {
      type: "delta";
      marketTicker: string;
      marketId: string;
      tsMs: number;
      recvTsMs: number;
      side: Side;
      priceDollars: string;
      deltaFp: string;
    };

export function newBookState(marketTicker: string, marketId: string): KalshiBookState {
  return {
    marketTicker,
    marketId,
    tsMs: 0,
    recvTsMs: 0,
    yesLevels: new Map(),
    noLevels: new Map(),
    initialized: false,
    terminated: false,
    deltasApplied: 0,
    snapshotsApplied: 0,
    deltasSkipped: 0,
  };
}

export function applySnapshot(
  state: KalshiBookState,
  ev: Extract<BookEvent, { type: "snapshot" }>
): void {
  state.yesLevels.clear();
  state.noLevels.clear();
  for (const [p, s] of ev.yesLevels) {
    const size = sizeToNum(s);
    if (size > 0) state.yesLevels.set(priceToTicks(p), size);
  }
  for (const [p, s] of ev.noLevels) {
    const size = sizeToNum(s);
    if (size > 0) state.noLevels.set(priceToTicks(p), size);
  }
  state.tsMs = ev.tsMs;
  state.recvTsMs = ev.recvTsMs;
  state.initialized = true;
  state.terminated = false;
  state.snapshotsApplied += 1;
}

export function applyTerminalSnapshot(
  state: KalshiBookState,
  ev: Extract<BookEvent, { type: "snapshot_terminal" }>
): void {
  state.tsMs = ev.tsMs;
  state.recvTsMs = ev.recvTsMs;
  state.terminated = true;
}

const ZERO_TOL = 1e-9;

export function applyDelta(
  state: KalshiBookState,
  ev: Extract<BookEvent, { type: "delta" }>
): boolean {
  if (!state.initialized || state.terminated) {
    state.deltasSkipped += 1;
    return false;
  }
  const map = ev.side === "yes" ? state.yesLevels : state.noLevels;
  const pt = priceToTicks(ev.priceDollars);
  const cur = map.get(pt) ?? 0;
  const next = cur + sizeToNum(ev.deltaFp);
  if (next <= ZERO_TOL) map.delete(pt);
  else map.set(pt, next);
  state.tsMs = ev.tsMs;
  state.recvTsMs = ev.recvTsMs;
  state.deltasApplied += 1;
  return true;
}

// Best YES bid: highest price at which someone is willing to buy YES.
export function bestYesBid(state: KalshiBookState): number | null {
  let best = -1;
  for (const [p, s] of state.yesLevels) {
    if (s > ZERO_TOL && p > best) best = p;
  }
  return best < 0 ? null : ticksToDollars(best);
}

export function bestNoBid(state: KalshiBookState): number | null {
  let best = -1;
  for (const [p, s] of state.noLevels) {
    if (s > ZERO_TOL && p > best) best = p;
  }
  return best < 0 ? null : ticksToDollars(best);
}

// Asks via no-arb.
export function bestYesAsk(state: KalshiBookState): number | null {
  const nb = bestNoBid(state);
  return nb === null ? null : 1 - nb;
}

export function bestNoAsk(state: KalshiBookState): number | null {
  const yb = bestYesBid(state);
  return yb === null ? null : 1 - yb;
}

// mid_yes = (best_yes_bid + best_yes_ask) / 2.
// Returns null when either side is empty.
export function midYes(state: KalshiBookState): number | null {
  const b = bestYesBid(state);
  const a = bestYesAsk(state);
  if (b === null || a === null) return null;
  return (a + b) / 2;
}

export function spreadYes(state: KalshiBookState): number | null {
  const b = bestYesBid(state);
  const a = bestYesAsk(state);
  if (b === null || a === null) return null;
  return a - b;
}

// Sum of all sizes on a side. Used by queue-position modeling later.
export function depthAt(state: KalshiBookState, side: Side, priceDollars: string): number {
  const map = side === "yes" ? state.yesLevels : state.noLevels;
  return map.get(priceToTicks(priceDollars)) ?? 0;
}

// ---------- event parsing ----------

interface RawLine {
  recv_ts_ms: number;
  raw: {
    type: string;
    sid?: number;
    seq?: number;
    msg?: {
      market_ticker?: string;
      market_id?: string;
      ts_ms?: number;
      // delta
      side?: Side;
      price_dollars?: string;
      delta_fp?: string;
      // snapshot
      yes_dollars_fp?: Array<[string, string]>;
      no_dollars_fp?: Array<[string, string]>;
    };
  };
}

export function parseLine(line: string): BookEvent | null {
  let d: RawLine;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const raw = d.raw;
  if (!raw || !raw.msg) return null;
  const m = raw.msg;
  if (!m.market_ticker || !m.market_id) return null;
  const tsMs = m.ts_ms ?? d.recv_ts_ms;
  const recvTsMs = d.recv_ts_ms;
  if (raw.type === "orderbook_snapshot") {
    if (m.yes_dollars_fp || m.no_dollars_fp) {
      return {
        type: "snapshot",
        marketTicker: m.market_ticker,
        marketId: m.market_id,
        tsMs,
        recvTsMs,
        yesLevels: m.yes_dollars_fp ?? [],
        noLevels: m.no_dollars_fp ?? [],
      };
    }
    return {
      type: "snapshot_terminal",
      marketTicker: m.market_ticker,
      marketId: m.market_id,
      tsMs,
      recvTsMs,
    };
  }
  if (raw.type === "orderbook_delta") {
    if (!m.side || !m.price_dollars || !m.delta_fp) return null;
    return {
      type: "delta",
      marketTicker: m.market_ticker,
      marketId: m.market_id,
      tsMs,
      recvTsMs,
      side: m.side,
      priceDollars: m.price_dollars,
      deltaFp: m.delta_fp,
    };
  }
  return null;
}

// ---------- file discovery + chronological streaming ----------

export interface FileDiscovery {
  snapshots: string[]; // hourly snapshot files in chronological order
  deltas: string[];    // hourly delta files in chronological order
}

export function discoverBookFiles(logDir: string): FileDiscovery {
  const entries = readdirSync(logDir);
  const snapshots: string[] = [];
  const deltas: string[] = [];
  for (const f of entries) {
    if (f.startsWith("orderbook-snapshots-") && f.endsWith(".jsonl.gz")) {
      snapshots.push(resolve(logDir, f));
    } else if (f.startsWith("orderbook-deltas-") && f.endsWith(".jsonl.gz")) {
      deltas.push(resolve(logDir, f));
    }
  }
  snapshots.sort();
  deltas.sort();
  return { snapshots, deltas };
}

async function* readGzLines(path: string): AsyncGenerator<string> {
  const gz = createReadStream(path).pipe(createGunzip());
  gz.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "Z_BUF_ERROR" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      process.stderr.write(`[bookReconstructor] decompress ${path}: ${err.message}\n`);
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

// Hourly chronological merger.
//
// The two channels (snapshots, deltas) are split by hour. Within an hour
// we merge-sort by (tsMs, type-tiebreak), where snapshots tie-break BEFORE
// deltas at the same tsMs so that a fresh snapshot reseats the book before
// any delta at the identical timestamp would apply.
//
// Crossing hour boundaries: the gzip files are rotated on local-hour
// boundaries, so a single market's event stream is split across consecutive
// files in chronological order. We process each (snapshot-file, delta-file)
// pair as a single hour, then move on.
async function* mergeHour(
  snapshotPath: string | null,
  deltaPath: string | null,
  filter?: (marketTicker: string) => boolean
): AsyncGenerator<BookEvent> {
  const events: BookEvent[] = [];
  if (snapshotPath) {
    for await (const line of readGzLines(snapshotPath)) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (filter && !filter(ev.marketTicker)) continue;
      events.push(ev);
    }
  }
  if (deltaPath) {
    for await (const line of readGzLines(deltaPath)) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (filter && !filter(ev.marketTicker)) continue;
      events.push(ev);
    }
  }
  // Stable sort: by tsMs, then snapshot < snapshot_terminal < delta.
  // Reasoning: at identical tsMs, a fresh snapshot must reseat the book
  // before deltas at the same tick apply. snapshot_terminal at identical
  // tsMs as deltas should NOT eat those deltas, so terminal comes after.
  const rank: Record<BookEvent["type"], number> = {
    snapshot: 0,
    delta: 1,
    snapshot_terminal: 2,
  };
  events.sort((a, b) => {
    if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    if (a.recvTsMs !== b.recvTsMs) return a.recvTsMs - b.recvTsMs;
    return rank[a.type] - rank[b.type];
  });
  for (const ev of events) yield ev;
}

// Pair snapshot and delta files by hour suffix.
function pairFilesByHour(disc: FileDiscovery): Array<{ hour: string; snap: string | null; delta: string | null }> {
  const hours = new Map<string, { snap: string | null; delta: string | null }>();
  const hourOf = (path: string): string => {
    const m = path.match(/-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl\.gz$/);
    return m ? m[1]! : "";
  };
  for (const p of disc.snapshots) {
    const h = hourOf(p);
    if (!hours.has(h)) hours.set(h, { snap: null, delta: null });
    hours.get(h)!.snap = p;
  }
  for (const p of disc.deltas) {
    const h = hourOf(p);
    if (!hours.has(h)) hours.set(h, { snap: null, delta: null });
    hours.get(h)!.delta = p;
  }
  return [...hours.entries()]
    .map(([hour, v]) => ({ hour, ...v }))
    .filter((e) => e.hour !== "")
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

// Stream all book events across the full log dir in chronological order.
// Yields events one at a time. Caller is responsible for maintaining
// the Map<marketTicker, KalshiBookState> and applying each event.
export async function* streamBookEvents(
  logDir: string,
  filter?: (marketTicker: string) => boolean
): AsyncGenerator<BookEvent> {
  const disc = discoverBookFiles(logDir);
  const hours = pairFilesByHour(disc);
  for (const h of hours) {
    yield* mergeHour(h.snap, h.delta, filter);
  }
}

// Convenience: drive reconstruction over the full log dir, invoking
// `onMid` after every applied event for which a valid mid_yes exists.
//
// `onMid` is the hot path during validation — keep it cheap. It receives
// the SAME state object on every call (don't retain references; copy what
// you need).
export type ReconstructCallback = (state: KalshiBookState, event: BookEvent) => void;

export async function reconstructAll(
  logDir: string,
  filter: (marketTicker: string) => boolean,
  onEvent: ReconstructCallback
): Promise<Map<string, KalshiBookState>> {
  const books = new Map<string, KalshiBookState>();
  for await (const ev of streamBookEvents(logDir, filter)) {
    let state = books.get(ev.marketTicker);
    if (!state) {
      state = newBookState(ev.marketTicker, ev.marketId);
      books.set(ev.marketTicker, state);
    }
    if (ev.type === "snapshot") applySnapshot(state, ev);
    else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
    else applyDelta(state, ev);
    onEvent(state, ev);
  }
  return books;
}
