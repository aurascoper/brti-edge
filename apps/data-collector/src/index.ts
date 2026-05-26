// Read-only Kalshi market data collector.
//
// SCOPE — what this does:
//   - Connect to Kalshi WebSocket wss://api.elections.kalshi.com/trade-api/ws/v2
//     with RSA-PSS authenticated handshake (re-uses signRequest from kalshi-client).
//   - Subscribe to PUBLIC channels only: orderbook_delta, trade, ticker.
//     (orderbook_snapshot is sent automatically by Kalshi as the first event
//     of any orderbook_delta subscription.)
//   - Track the 7 BRTI-covered crypto 15M series: BTC ETH SOL BNB DOGE XRP HYPE.
//     (BCH and ADA excluded — no BRTI spot coverage; not in scope for AS work.)
//   - Discover current open markets per series via REST every 60s and
//     diff-subscribe (new tickers get subscribed; expired ones get unsubscribed).
//   - Persist every raw inbound WS message to per-channel hourly-rotated
//     gzipped JSONL under logs/data-collector/.
//   - Reconnect on disconnect with exponential backoff.
//
// SCOPE — what this does NOT do (intentional):
//   - No private channels (no fill, no order_status, no market_positions).
//     Maker order placement is out of scope until the harness gates pass.
//   - No order submission. The Kalshi client adapter is not even imported.
//   - No book reconstruction at runtime. Raw deltas are persisted; the
//     replay harness will reconstruct offline.
//   - No interaction with the kalshi-worker process, its state files, or
//     its log directory. This collector writes to its own log path.
//
// Run:
//   cd apps/data-collector && pnpm run start
//
// Env required:
//   KALSHI_API_KEY_ID         — UUID of the key
//   KALSHI_PRIVATE_KEY_PATH   — path to PEM
//   (loaded automatically from /Users/aurascoper/Developer/live_trading/.env
//    if not set, same convention as kalshi-worker)
//
// Env optional:
//   DATA_COLLECTOR_LOG_DIR    — default logs/data-collector
//   DATA_COLLECTOR_REFRESH_MS — market-list refresh cadence (default 60_000)
//   DATA_COLLECTOR_HEARTBEAT_MS — stdout counter snapshot (default 60_000)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSign } from "node:crypto";
import WebSocket from "ws";
import {
  KalshiClient,
  CRYPTO_15M_SERIES,
  loadCredentialsFromEnv,
  type KalshiCredentials,
} from "@polyterminal/kalshi-client";
import { MultiChannelRotator } from "./persistence";

// ---------- config ----------

loadEnvFromLiveTrading();

const WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";
// WS sign path differs from REST: REST uses /trade-api/v2/..., WS uses
// /trade-api/ws/v2. Verified 2026-05-25 against Kalshi docs + multiple
// reference impls. The kalshi-client/src/auth.ts signRequest helper
// hard-asserts the /trade-api/v2/ REST prefix, so we sign WS locally here.
const WS_SIGN_PATH = "/trade-api/ws/v2";

// Local WS-handshake signer. Same RSA-PSS scheme as REST (timestamp_ms
// string + method + path), but bypasses the REST-specific prefix assertion.
function signWsHandshake(creds: KalshiCredentials): Record<string, string> {
  const ts = Date.now().toString();
  const message = `${ts}GET${WS_SIGN_PATH}`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  const signature = signer.sign(
    {
      key: creds.privateKey,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32, // PSS_DIGEST_LENGTH
    },
    "base64",
  );
  return {
    "KALSHI-ACCESS-KEY": creds.keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": ts,
  };
}
const LOG_DIR = resolve(
  process.cwd(),
  process.env.DATA_COLLECTOR_LOG_DIR ?? "logs/data-collector",
);
const REFRESH_MS = numEnv("DATA_COLLECTOR_REFRESH_MS", 60_000);
const HEARTBEAT_MS = numEnv("DATA_COLLECTOR_HEARTBEAT_MS", 60_000);

// The 7 BRTI-covered crypto series. Stays in sync with kalshi-worker's
// BRTI_SYMBOLS, NOT the full CRYPTO_15M_SERIES list. BCH/ADA omitted.
const TARGET_SERIES = new Set(["KXBTC15M", "KXETH15M", "KXSOL15M", "KXBNB15M", "KXDOGE15M", "KXXRP15M", "KXHYPE15M"]);

// Reconnect backoff: 1s, 2s, 4s, ... capped at 30s. Reset on successful sub-ack.
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// Channels we collect. orderbook_delta produces an initial orderbook_snapshot
// followed by deltas, so we don't need to list snapshot separately.
const CHANNELS = ["orderbook_delta", "trade", "ticker"] as const;

// ---------- state ----------

interface CollectorState {
  startedAt: number;
  connectedAt: number | null;
  reconnects: number;
  lastReconnectError: string | null;
  subscriptions: {
    nextId: number;
    pendingByMessageId: Map<number, { cmd: string; tickers?: string[] }>;
    subscribedTickers: Set<string>;
    subscriptionIdByChannel: Map<string, number>; // server-assigned sid per channel
  };
  counters: {
    msgs_total: number;
    by_type: Record<string, number>;
    last_msg_at: number;
  };
}

const state: CollectorState = {
  startedAt: Date.now(),
  connectedAt: null,
  reconnects: 0,
  lastReconnectError: null,
  subscriptions: {
    nextId: 1,
    pendingByMessageId: new Map(),
    subscribedTickers: new Set(),
    subscriptionIdByChannel: new Map(),
  },
  counters: {
    msgs_total: 0,
    by_type: {},
    last_msg_at: 0,
  },
};

const rotator = new MultiChannelRotator(LOG_DIR);
const client = new KalshiClient(); // read-only REST for market discovery
let creds: KalshiCredentials;
try {
  creds = loadCredentialsFromEnv();
} catch (err) {
  console.error("[data-collector] credentials missing:", (err as Error).message);
  process.exit(1);
}

let ws: WebSocket | null = null;
let reconnectDelayMs = RECONNECT_INITIAL_MS;
let refreshTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

// ---------- market discovery ----------

async function discoverOpenMarkets(): Promise<string[]> {
  const tickers: string[] = [];
  for (const cfg of CRYPTO_15M_SERIES) {
    if (!TARGET_SERIES.has(cfg.series)) continue;
    try {
      const r = await client.listMarkets({ status: "open", series_ticker: cfg.series, limit: 10 });
      for (const m of r.markets ?? []) {
        if (m.ticker) tickers.push(m.ticker);
      }
    } catch (err) {
      console.warn(`[data-collector] discoverOpenMarkets(${cfg.series}) failed:`, (err as Error).message);
    }
  }
  return tickers;
}

async function refreshSubscriptions(): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const open = await discoverOpenMarkets();
  const openSet = new Set(open);
  const current = state.subscriptions.subscribedTickers;
  const toAdd = open.filter((t) => !current.has(t));
  const toRemove = Array.from(current).filter((t) => !openSet.has(t));

  if (toAdd.length > 0) {
    // Subscribe in one batched message per channel to keep id-tracking simple.
    sendSubscribe(toAdd);
    for (const t of toAdd) current.add(t);
  }
  if (toRemove.length > 0) {
    sendUnsubscribe(toRemove);
    for (const t of toRemove) current.delete(t);
  }
  if (toAdd.length || toRemove.length) {
    logLifecycle({
      event: "refresh_subscriptions",
      added: toAdd,
      removed: toRemove,
      total_now: current.size,
    });
  }
}

// ---------- subscribe / unsubscribe ----------

function sendSubscribe(tickers: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || tickers.length === 0) return;
  const id = state.subscriptions.nextId++;
  const msg = {
    id,
    cmd: "subscribe",
    params: {
      channels: CHANNELS,
      market_tickers: tickers,
    },
  };
  state.subscriptions.pendingByMessageId.set(id, { cmd: "subscribe", tickers });
  ws.send(JSON.stringify(msg));
}

function sendUnsubscribe(tickers: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || tickers.length === 0) return;
  // Kalshi: per-sid unsubscribe is one channel at a time. We track per-channel
  // sids during subscription_ok; unsubscribing by market_tickers is supported
  // via the update_subscription / unsubscribe cmd depending on API version.
  // We use the safer pattern: send an unsubscribe command with the tickers,
  // letting Kalshi 4xx if it's not supported (we log + continue).
  const id = state.subscriptions.nextId++;
  const msg = {
    id,
    cmd: "unsubscribe",
    params: { market_tickers: tickers },
  };
  state.subscriptions.pendingByMessageId.set(id, { cmd: "unsubscribe", tickers });
  ws.send(JSON.stringify(msg));
}

// ---------- WS connection ----------

function connect(): void {
  const headersForWs = signWsHandshake(creds);
  const sock = new WebSocket(WS_URL, { headers: headersForWs, perMessageDeflate: false });
  ws = sock;

  sock.on("open", () => {
    state.connectedAt = Date.now();
    reconnectDelayMs = RECONNECT_INITIAL_MS;
    logLifecycle({ event: "ws_open", url: WS_URL });
    console.log("[data-collector] ws open");
    // Initial market discovery + subscribe.
    void (async () => {
      const open = await discoverOpenMarkets();
      if (open.length === 0) {
        logLifecycle({ event: "discover_empty" });
        return;
      }
      sendSubscribe(open);
      for (const t of open) state.subscriptions.subscribedTickers.add(t);
      logLifecycle({ event: "initial_subscribe", tickers: open });
      console.log(`[data-collector] subscribed to ${open.length} markets`);
    })();
  });

  // ws defaults to emitting Buffer; we only configure the default path so
  // typing as Buffer is correct in practice. After @types/ws installs this
  // can be widened to RawData if needed.
  sock.on("message", (raw: Buffer, isBinary: boolean) => {
    state.counters.msgs_total += 1;
    state.counters.last_msg_at = Date.now();
    const text = isBinary ? raw.toString("utf8") : raw.toString();
    let msg: { type?: string; msg?: unknown; id?: number; sid?: number };
    try {
      msg = JSON.parse(text);
    } catch (err) {
      logLifecycle({ event: "parse_error", error: (err as Error).message, raw: text.slice(0, 200) });
      return;
    }
    const type = String(msg.type ?? "unknown");
    state.counters.by_type[type] = (state.counters.by_type[type] ?? 0) + 1;

    // Persist by message type. We DO NOT alter the payload — JSON-stringify
    // the inbound shape verbatim, with one added local field "recv_ts_ms".
    const persistObj = { recv_ts_ms: state.counters.last_msg_at, raw: msg };

    if (type === "orderbook_snapshot" || type === "orderbook_delta") {
      rotator.write(type === "orderbook_snapshot" ? "orderbook-snapshots" : "orderbook-deltas", persistObj);
    } else if (type === "trade") {
      rotator.write("trades", persistObj);
    } else if (type === "ticker_v2" || type === "ticker") {
      rotator.write("tickers", persistObj);
    } else if (type === "subscribed" || type === "unsubscribed" || type === "ok" || type === "error") {
      logLifecycle({ event: "control_msg", msg });
      // Track sid per channel on subscribed
      if (type === "subscribed" && msg.id != null && msg.sid != null) {
        const pending = state.subscriptions.pendingByMessageId.get(msg.id);
        if (pending) {
          state.subscriptions.pendingByMessageId.delete(msg.id);
        }
      }
    } else {
      // Unknown type — persist to lifecycle for inspection but DO NOT drop.
      logLifecycle({ event: "unknown_type", type, msg });
    }
  });

  sock.on("close", (code: number, reason: Buffer) => {
    logLifecycle({ event: "ws_close", code, reason: reason.toString() });
    console.warn(`[data-collector] ws close code=${code} reason=${reason.toString()}`);
    state.connectedAt = null;
    if (shuttingDown) return;
    scheduleReconnect();
  });

  sock.on("error", (err: Error) => {
    state.lastReconnectError = err.message;
    logLifecycle({ event: "ws_error", error: err.message });
    console.warn("[data-collector] ws error:", err.message);
    // The 'close' handler fires after 'error', which triggers reconnect.
  });
}

function scheduleReconnect(): void {
  if (shuttingDown) return;
  state.reconnects += 1;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  console.log(`[data-collector] reconnecting in ${delay}ms (attempt ${state.reconnects})`);
  setTimeout(connect, delay);
  // Forget prior subs — we'll re-discover and re-subscribe on next open.
  state.subscriptions.subscribedTickers.clear();
}

// ---------- lifecycle log ----------

function logLifecycle(obj: Record<string, unknown>): void {
  rotator.write("lifecycle", { recv_ts_ms: Date.now(), ...obj });
}

// ---------- heartbeat ----------

function logHeartbeat(): void {
  const now = Date.now();
  const upSec = Math.round((now - state.startedAt) / 1000);
  const channelStats = rotator.statsByChannel();
  const byType = state.counters.by_type;
  const totalBytes = Object.values(channelStats).reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  const heartbeat = {
    ts: new Date(now).toISOString(),
    up_sec: upSec,
    connected: state.connectedAt !== null,
    reconnects: state.reconnects,
    subscribed_markets: state.subscriptions.subscribedTickers.size,
    msgs_total: state.counters.msgs_total,
    msgs_by_type: byType,
    bytes_this_hour_per_channel: Object.fromEntries(
      Object.entries(channelStats).map(([k, v]) => [k, v.bytes ?? 0]),
    ),
    bytes_this_hour_total: totalBytes,
  };
  logLifecycle({ event: "heartbeat", ...heartbeat });
  console.log(
    `[data-collector] up=${upSec}s subs=${state.subscriptions.subscribedTickers.size} ` +
      `msgs=${state.counters.msgs_total} reconnects=${state.reconnects} ` +
      `bytes_hour=${totalBytes}`,
  );
}

// ---------- env helpers ----------

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadEnvFromLiveTrading(): void {
  if (process.env.KALSHI_API_KEY_ID && process.env.KALSHI_PRIVATE_KEY_PATH) return;
  const envPath = "/Users/aurascoper/Developer/live_trading/.env";
  if (!existsSync(envPath)) return;
  try {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1]?.startsWith("KALSHI_")) {
        if (!process.env[m[1]]) process.env[m[1]] = m[2];
      }
    }
  } catch {
    // ignore
  }
}

// ---------- shutdown ----------

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[data-collector] shutdown: ${reason}`);
  logLifecycle({ event: "shutdown", reason });
  if (refreshTimer) clearInterval(refreshTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (ws) {
    try {
      ws.close(1000, "normal");
    } catch {
      // ignore
    }
  }
  // Wait for every gzip stream to emit 'finish' so the trailer (CRC32 +
  // size) lands on disk before we exit. closeAsync() has a 3s safety
  // timeout per rotator so a hung stream cannot block forever; the
  // wrapper script's SIGKILL fires at +5s as final backstop.
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
  console.error("[data-collector] uncaughtException:", err);
  logLifecycle({ event: "uncaught_exception", error: String(err) });
  void shutdown("uncaughtException");
});

// ---------- main ----------

async function main(): Promise<void> {
  console.log("[data-collector] starting");
  console.log(`[data-collector] log dir: ${LOG_DIR}`);
  console.log(`[data-collector] target series: ${Array.from(TARGET_SERIES).join(", ")}`);
  console.log(`[data-collector] channels: ${CHANNELS.join(", ")}`);
  console.log(`[data-collector] refresh interval: ${REFRESH_MS}ms`);
  logLifecycle({
    event: "start",
    target_series: Array.from(TARGET_SERIES),
    channels: CHANNELS,
    refresh_ms: REFRESH_MS,
    log_dir: LOG_DIR,
  });

  connect();

  refreshTimer = setInterval(() => {
    void refreshSubscriptions();
  }, REFRESH_MS);
  heartbeatTimer = setInterval(logHeartbeat, HEARTBEAT_MS);
}

void main();
