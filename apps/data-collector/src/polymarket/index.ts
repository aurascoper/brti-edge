// Read-only Polymarket up/down tape archiver (Phase 0).
//
// SCOPE — what this does:
//   - Discover current btc/eth/sol up/down markets via gamma every
//     PM_COLLECTOR_REFRESH_MS (two-batch pagination, see discovery.ts).
//   - Subscribe BOTH clobTokenIds of every tracked market on ONE market WS
//     (public channel, no credentials).
//   - On token-set change: close and reconnect with the new asset list.
//     Same pattern as apps/market-worker/src/index.ts reconnectWs() — each
//     reconnect makes the venue re-emit full book snapshots, which is the
//     reconstruction seed for the tape.
//   - Persist all four MarketWsMessage types raw to per-channel hourly
//     gzip JSONL (MultiChannelRotator): book -> pm-book, price_change ->
//     pm-price-change, tick_size_change -> pm-tick-size, last_trade_price ->
//     pm-last-trade.
//   - On discovery, write market metadata rows to pm-markets; keep polling
//     ended markets via gamma until resolved, then write a final pm-markets
//     row with the resolution.
//   - Binance spot trades for btcusdt/ethusdt/solusdt -> spot-trades
//     (spotFeed.ts).
//   - Heartbeat: one JSON line on the meta channel every
//     PM_COLLECTOR_HEARTBEAT_MS with per-channel row counts since last beat.
//
// SCOPE — what this does NOT do (intentional):
//   - No order flow, no auth, no private channels. Public tape only.
//   - No book reconstruction at runtime; raw messages are persisted and the
//     replay harness reconstructs offline.
//   - No interaction with the market-worker process or its state/logs.
//
// Row shape (every channel): { src_ts, ingest_ts, ...payload } where src_ts
// is the venue timestamp when present (else null) and ingest_ts is local
// Date.now() at persist time.
//
// Run:
//   cd apps/data-collector && pnpm run polymarket-collector
//
// Env (all optional):
//   PM_COLLECTOR_LOG_DIR      — default logs/polymarket
//   PM_COLLECTOR_ASSETS       — default btc,eth,sol
//   PM_COLLECTOR_REFRESH_MS   — discovery cadence (default 30_000)
//   PM_COLLECTOR_HEARTBEAT_MS — meta heartbeat cadence (default 60_000)
//   PM_SPOT_WS_URL            — spot feed WS base (default
//                               wss://data-stream.binance.vision, see spotFeed.ts)

import { resolve } from "node:path";
import WebSocket from "ws";
import {
  connectMarketWs,
  type MarketWsHandle,
  type MarketWsMessage,
} from "@polyterminal/polymarket-client";
import { MultiChannelRotator } from "../persistence";
import {
  discoverUpDownMarkets,
  fetchMarketsByConditionIds,
  parseAssets,
  resolutionOf,
  type TrackedMarket,
} from "./discovery";
import { startSpotFeed, type SpotFeedHandle } from "./spotFeed";

// ---------- config ----------

const LOG_DIR = resolve(process.cwd(), process.env.PM_COLLECTOR_LOG_DIR ?? "logs/polymarket");
const ASSETS = parseAssets(process.env.PM_COLLECTOR_ASSETS);
const REFRESH_MS = numEnv("PM_COLLECTOR_REFRESH_MS", 30_000);
const HEARTBEAT_MS = numEnv("PM_COLLECTOR_HEARTBEAT_MS", 60_000);

// Market-WS reconnect backoff after an unexpected close: 1s, 2s, ... 30s.
const WS_RECONNECT_INITIAL_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

// A market stuck unresolved for this long gets an explicit timeout row and
// is dropped from the sweep so the pending map cannot grow without bound.
const RESOLUTION_TIMEOUT_MS = 7 * 24 * 3_600_000;

const CH_BOOK = "pm-book";
const CH_PRICE_CHANGE = "pm-price-change";
const CH_TICK_SIZE = "pm-tick-size";
const CH_LAST_TRADE = "pm-last-trade";
const CH_MARKETS = "pm-markets";
const CH_SPOT = "spot-trades";
const CH_META = "meta";

const DATA_CHANNELS = [CH_BOOK, CH_PRICE_CHANGE, CH_TICK_SIZE, CH_LAST_TRADE, CH_MARKETS, CH_SPOT] as const;

// ---------- state ----------

const rotator = new MultiChannelRotator(LOG_DIR);

const tracked = new Map<string, TrackedMarket>(); // by conditionId
const pendingResolution = new Map<string, { market: TrackedMarket; since: number }>();

let wsHandle: MarketWsHandle | null = null;
let wsGeneration = 0; // bumped on every intentional close so stale onClose callbacks are ignored
let wsConnected = false;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
let wsReconnects = 0;
let subscribedKey = ""; // sorted-joined token ids currently subscribed
let spotHandle: SpotFeedHandle | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let refreshInFlight = false;
let shuttingDown = false;

const startedAt = Date.now();
const countsSinceBeat: Record<string, number> = {};
for (const ch of DATA_CHANNELS) countsSinceBeat[ch] = 0;
let spotSilentBeats = 0; // consecutive heartbeats with zero spot-trades rows

// ---------- persistence ----------

function persist(channel: string, srcTs: number | null, payload: Record<string, unknown>): void {
  rotator.write(channel, { src_ts: srcTs, ingest_ts: Date.now(), ...payload });
  if (channel !== CH_META) {
    countsSinceBeat[channel] = (countsSinceBeat[channel] ?? 0) + 1;
  }
}

function logMeta(obj: Record<string, unknown>): void {
  persist(CH_META, null, obj);
}

// ---------- market WS ----------

function venueTs(msg: MarketWsMessage): number | null {
  const n = Number(msg.timestamp);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function handleWsMessage(msg: MarketWsMessage): void {
  const row = msg as unknown as Record<string, unknown>;
  switch (msg.event_type) {
    case "book":
      persist(CH_BOOK, venueTs(msg), row);
      break;
    case "price_change":
      persist(CH_PRICE_CHANGE, venueTs(msg), row);
      break;
    case "tick_size_change":
      persist(CH_TICK_SIZE, venueTs(msg), row);
      break;
    case "last_trade_price":
      persist(CH_LAST_TRADE, venueTs(msg), row);
      break;
    default:
      // Unknown event type — keep the tape complete, park it on meta.
      logMeta({ event: "unknown_ws_message", raw: row });
  }
}

function currentTokenIds(): string[] {
  const ids: string[] = [];
  for (const m of tracked.values()) for (const t of m.tokenIds) ids.push(t);
  return ids;
}

// Close-and-reconnect-on-token-set-change (market-worker reconnectWs pattern).
function reconnectMarketWs(tokenIds: string[]): void {
  wsGeneration += 1;
  const gen = wsGeneration;
  wsHandle?.close();
  wsHandle = null;
  wsConnected = false;
  if (tokenIds.length === 0 || shuttingDown) return;
  wsHandle = connectMarketWs({
    assetIds: tokenIds,
    WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
    onOpen: () => {
      if (gen !== wsGeneration) return;
      wsConnected = true;
      wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
      logMeta({ event: "ws_open", tokens: tokenIds.length, markets: tracked.size });
      console.log(`[pm-collector] ws open: ${tokenIds.length} tokens / ${tracked.size} markets`);
    },
    onClose: () => {
      if (gen !== wsGeneration || shuttingDown) return;
      wsConnected = false;
      scheduleWsReconnect();
    },
    onError: (err) => {
      if (gen !== wsGeneration) return;
      logMeta({ event: "ws_error", error: String((err as Error)?.message ?? err) });
    },
    onMessage: (msg) => {
      // A replaced socket keeps emitting already-received frames until its
      // close handshake completes; drop them so the tape never interleaves
      // stale rows from the previous subscription.
      if (gen !== wsGeneration) return;
      handleWsMessage(msg);
    },
  });
}

function scheduleWsReconnect(): void {
  if (shuttingDown) return;
  wsReconnects += 1;
  const gen = wsGeneration;
  const delay = wsReconnectDelayMs;
  wsReconnectDelayMs = Math.min(wsReconnectDelayMs * 2, WS_RECONNECT_MAX_MS);
  logMeta({ event: "ws_reconnect_scheduled", delay_ms: delay, attempt: wsReconnects });
  console.warn(`[pm-collector] ws closed; reconnecting in ${delay}ms (attempt ${wsReconnects})`);
  setTimeout(() => {
    // If a discovery-driven reconnect already replaced the socket while this
    // timer was pending, don't tear the healthy connection down again.
    if (shuttingDown || gen !== wsGeneration) return;
    reconnectMarketWs(currentTokenIds());
  }, delay);
}

// ---------- discovery + settlement sweep ----------

function marketMetadataRow(m: TrackedMarket): Record<string, unknown> {
  return {
    asset: m.asset,
    slug: m.slug,
    conditionId: m.conditionId,
    question: m.question,
    tokenIds: m.tokenIds,
    outcomes: m.outcomes,
    endDate: m.endDate,
    negRisk: m.negRisk,
    fee: m.fee,
    makerBaseFee: m.makerBaseFee,
    takerBaseFee: m.takerBaseFee,
    orderPriceMinTickSize: m.orderPriceMinTickSize,
    orderMinSize: m.orderMinSize,
    eventSlug: m.eventSlug,
    eventTitle: m.eventTitle,
  };
}

async function refreshDiscovery(): Promise<void> {
  if (refreshInFlight || shuttingDown) return;
  refreshInFlight = true;
  try {
    let markets: TrackedMarket[];
    try {
      markets = await discoverUpDownMarkets(ASSETS);
    } catch (err) {
      logMeta({ event: "discover_error", error: (err as Error).message });
      console.warn("[pm-collector] discovery failed:", (err as Error).message);
      return;
    }

    const seen = new Set<string>();
    let added = 0;
    for (const m of markets) {
      seen.add(m.conditionId);
      if (!tracked.has(m.conditionId)) {
        tracked.set(m.conditionId, m);
        persist(CH_MARKETS, null, { kind: "discovered", ...marketMetadataRow(m) });
        added += 1;
      }
    }
    // Markets that left the discovery set (ended or delisted) move to the
    // settlement sweep and stay there until gamma reports a resolution.
    let removed = 0;
    for (const [cid, m] of tracked) {
      if (!seen.has(cid)) {
        tracked.delete(cid);
        pendingResolution.set(cid, { market: m, since: Date.now() });
        removed += 1;
      }
    }
    if (added || removed) {
      logMeta({
        event: "discovery_refresh",
        added,
        removed,
        tracked: tracked.size,
        pending_resolution: pendingResolution.size,
      });
    }

    const tokens = currentTokenIds();
    const key = tokens.slice().sort().join(",");
    if (key !== subscribedKey) {
      subscribedKey = key;
      logMeta({ event: "token_set_change", tokens: tokens.length, markets: tracked.size });
      reconnectMarketWs(tokens);
    }

    await sweepResolutions();
  } finally {
    refreshInFlight = false;
  }
}

async function sweepResolutions(): Promise<void> {
  if (pendingResolution.size === 0) return;
  let rows;
  try {
    rows = await fetchMarketsByConditionIds(Array.from(pendingResolution.keys()));
  } catch (err) {
    logMeta({ event: "sweep_error", error: (err as Error).message });
    return;
  }
  const now = Date.now();
  for (const row of rows) {
    const pending = pendingResolution.get(row.conditionId);
    if (!pending) continue;
    const res = resolutionOf(row, pending.market.outcomes);
    if (!res.resolved) continue;
    persist(CH_MARKETS, null, {
      kind: "resolved",
      ...marketMetadataRow(pending.market),
      resolution: {
        umaResolutionStatus: row.umaResolutionStatus ?? null,
        closed: !!row.closed,
        winningOutcome: res.winningOutcome,
        outcomePrices: res.outcomePrices,
      },
    });
    pendingResolution.delete(row.conditionId);
  }
  for (const [cid, pending] of pendingResolution) {
    if (now - pending.since > RESOLUTION_TIMEOUT_MS) {
      persist(CH_MARKETS, null, {
        kind: "resolution_timeout",
        ...marketMetadataRow(pending.market),
      });
      pendingResolution.delete(cid);
    }
  }
}

// ---------- heartbeat ----------

function logHeartbeat(): void {
  const now = Date.now();
  const counts: Record<string, number> = {};
  for (const ch of DATA_CHANNELS) counts[ch] = countsSinceBeat[ch] ?? 0;
  logMeta({
    event: "heartbeat",
    up_sec: Math.round((now - startedAt) / 1000),
    ws_connected: wsConnected,
    ws_reconnects: wsReconnects,
    tracked_markets: tracked.size,
    subscribed_tokens: subscribedKey === "" ? 0 : subscribedKey.split(",").length,
    pending_resolution: pendingResolution.size,
    counts_since_last_beat: counts,
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `[pm-collector] up=${Math.round((now - startedAt) / 1000)}s markets=${tracked.size} ` +
      `rows_since_beat=${total} ws=${wsConnected ? "up" : "down"} reconnects=${wsReconnects}`,
  );
  // Alarm on a silent spot feed: spot trades are dense (many per second), so
  // a full heartbeat interval with zero rows means the Binance leg is down
  // even if the Polymarket socket (ws_connected) looks healthy.
  if ((counts[CH_SPOT] ?? 0) === 0) {
    spotSilentBeats += 1;
    logMeta({ event: "spot_feed_silent", consecutive_beats: spotSilentBeats });
    console.warn(`[pm-collector] ALARM: spot-trades silent for ${spotSilentBeats} consecutive heartbeat(s)`);
  } else {
    spotSilentBeats = 0;
  }
  for (const ch of DATA_CHANNELS) countsSinceBeat[ch] = 0;
}

// ---------- env helpers ----------

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- shutdown ----------

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pm-collector] shutdown: ${reason}`);
  logMeta({ event: "shutdown", reason });
  if (refreshTimer) clearInterval(refreshTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  wsGeneration += 1; // silence stale onClose callbacks
  try {
    wsHandle?.close();
  } catch {
    // ignore
  }
  spotHandle?.close();
  // Wait for every gzip trailer to land so the .gz files are valid.
  await rotator.closeAsync();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("uncaughtException", (err) => {
  console.error("[pm-collector] uncaughtException:", err);
  logMeta({ event: "uncaught_exception", error: String(err) });
  void shutdown("uncaughtException");
});

// ---------- main ----------

async function main(): Promise<void> {
  console.log("[pm-collector] starting");
  console.log(`[pm-collector] log dir: ${LOG_DIR}`);
  console.log(`[pm-collector] assets: ${ASSETS.join(", ")}`);
  console.log(`[pm-collector] refresh: ${REFRESH_MS}ms, heartbeat: ${HEARTBEAT_MS}ms`);
  logMeta({
    event: "start",
    assets: ASSETS,
    refresh_ms: REFRESH_MS,
    heartbeat_ms: HEARTBEAT_MS,
    log_dir: LOG_DIR,
  });

  spotHandle = startSpotFeed({
    assets: ASSETS,
    onTrade: (row) => {
      persist(CH_SPOT, row.src_ts, { sym: row.sym, price: row.price, qty: row.qty });
    },
    onLifecycle: (obj) => logMeta(obj),
  });

  await refreshDiscovery();
  refreshTimer = setInterval(() => {
    void refreshDiscovery();
  }, REFRESH_MS);
  heartbeatTimer = setInterval(logHeartbeat, HEARTBEAT_MS);
}

void main();
