// Binance combined-stream spot trade feed (public, no credentials).
//
// One WS to <base>/stream?streams=<sym>usdt@trade/... where <base> defaults
// to wss://data-stream.binance.vision — Binance's unauthenticated market-data
// host, reachable from US deployments where stream.binance.com:9443 answers
// HTTP 451 (geo-block) on every attempt. Override with PM_SPOT_WS_URL.
// Combined-stream frames arrive as { stream, data } where data is the raw
// trade event: { e:"trade", E: eventTimeMs, s:"BTCUSDT", p:"...", q:"...", ... }.
// Price/qty are kept as the venue's decimal strings — this is a tape
// archiver, we do not convert to float on the write path.
//
// Reconnect: fixed 3s backoff (spot trades are dense enough that exponential
// backoff just loses tape for no benefit).

import WebSocket from "ws";

const RECONNECT_MS = 3_000;
const DEFAULT_WS_BASE = "wss://data-stream.binance.vision";

export interface SpotTradeRow {
  sym: string; // e.g. "btcusdt"
  price: string;
  qty: string;
  src_ts: number; // Binance E field (event time, ms)
}

export interface SpotFeedOptions {
  assets: string[]; // ["btc","eth","sol"] -> btcusdt@trade/...
  onTrade: (row: SpotTradeRow) => void;
  onLifecycle?: (obj: Record<string, unknown>) => void;
}

export interface SpotFeedHandle {
  close: () => void;
}

interface BinanceCombinedFrame {
  stream?: string;
  data?: {
    e?: string;
    E?: number;
    s?: string;
    p?: string;
    q?: string;
  };
}

export function startSpotFeed(opts: SpotFeedOptions): SpotFeedHandle {
  const streams = opts.assets.map((a) => `${a}usdt@trade`).join("/");
  const base = (process.env.PM_SPOT_WS_URL ?? DEFAULT_WS_BASE).replace(/\/$/, "");
  const url = `${base}/stream?streams=${streams}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const lifecycle = (obj: Record<string, unknown>): void => {
    opts.onLifecycle?.(obj);
  };

  const connect = (): void => {
    if (closed) return;
    const sock = new WebSocket(url, { perMessageDeflate: false });
    ws = sock;

    sock.on("open", () => {
      lifecycle({ event: "spot_ws_open", url });
    });

    sock.on("message", (raw: Buffer) => {
      let frame: BinanceCombinedFrame;
      try {
        frame = JSON.parse(raw.toString()) as BinanceCombinedFrame;
      } catch (err) {
        lifecycle({ event: "spot_parse_error", error: (err as Error).message });
        return;
      }
      const d = frame.data;
      if (!d || d.e !== "trade" || !d.s || d.p === undefined || d.q === undefined) return;
      opts.onTrade({
        sym: d.s.toLowerCase(),
        price: d.p,
        qty: d.q,
        src_ts: d.E ?? 0,
      });
    });

    sock.on("close", (code: number, reason: Buffer) => {
      lifecycle({ event: "spot_ws_close", code, reason: reason.toString() });
      if (closed) return;
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });

    sock.on("error", (err: Error) => {
      lifecycle({ event: "spot_ws_error", error: err.message });
      // 'close' fires after 'error' and schedules the reconnect.
    });
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close(1000, "shutdown");
      } catch {
        // ignore
      }
    },
  };
}
