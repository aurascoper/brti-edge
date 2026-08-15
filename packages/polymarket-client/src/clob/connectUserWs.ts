import { defaultEndpoints } from "../config";
import type { ApiCreds } from "../auth/types";

const PING_INTERVAL_MS = 10_000;

// Authenticated user-channel WebSocket (order + trade lifecycle events).
//
// IMPORTANT: the payload shapes below are transcribed from
// docs.polymarket.com (CLOB WSS API, user channel) and have NOT been
// verified against a live session. The canary MUST log raw frames and
// confirm these fields before trusting parsed events.
//
// Keepalive: docs.polymarket.com instructs clients to ping periodically or
// the server drops the connection, and the user channel — unlike the busy
// market channel — can sit idle for long stretches, so we send "PING" every
// PING_INTERVAL_MS while open. There is deliberately NO reconnect here: on
// close the timer is cleared and onClose fires once — the caller MUST
// supervise onClose and rebuild the session (fresh connect + resubscribe).

export interface UserWsOrderEvent {
  event_type: "order";
  // Lifecycle: PLACEMENT (new order), UPDATE (partial match), CANCELLATION.
  type: "PLACEMENT" | "UPDATE" | "CANCELLATION";
  id: string; // order id
  market: string; // condition id
  asset_id: string; // token id
  side: "BUY" | "SELL";
  price: string;
  original_size: string;
  size_matched: string;
  outcome: string;
  order_owner: string;
  owner: string;
  order_type: string;
  associate_trades: string[] | null;
  created_at: string;
  expiration: string;
  status: string;
  timestamp: string;
}

export interface UserWsTradeMakerOrder {
  order_id: string;
  owner: string;
  maker_address: string;
  matched_amount: string;
  price: string;
  fee_rate_bps: string;
  asset_id: string;
  outcome: string;
}

export interface UserWsTradeEvent {
  event_type: "trade";
  // Settlement lifecycle: MATCHED → MINED → CONFIRMED (RETRYING/FAILED on error).
  status: "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
  id: string; // trade id
  market: string; // condition id
  asset_id: string; // token id
  side: "BUY" | "SELL";
  size: string;
  price: string;
  outcome: string;
  owner: string;
  trade_owner: string;
  taker_order_id: string;
  maker_orders: UserWsTradeMakerOrder[];
  last_update: string;
  matchtime: string;
  timestamp: string;
  type: "TRADE";
}

export type UserWsMessage = UserWsOrderEvent | UserWsTradeEvent;

export interface UserWsHandle {
  close: () => void;
}

export interface ConnectUserWsOptions {
  creds: ApiCreds;
  conditionIds: string[]; // markets to subscribe to (condition ids)
  onOrder: (msg: UserWsOrderEvent) => void;
  onTrade: (msg: UserWsTradeEvent) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
  endpoints?: typeof defaultEndpoints;
  WebSocketCtor?: typeof WebSocket;
}

export function connectUserWs(opts: ConnectUserWsOptions): UserWsHandle {
  const endpoints = opts.endpoints ?? defaultEndpoints;
  const Ctor = opts.WebSocketCtor ?? (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
  if (!Ctor) throw new Error("WebSocket constructor unavailable; pass WebSocketCtor explicitly in Node");

  const url = `${endpoints.ws.replace(/\/$/, "")}/user`;
  const ws = new Ctor(url);
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stopPing = (): void => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        auth: {
          apiKey: opts.creds.key,
          secret: opts.creds.secret,
          passphrase: opts.creds.passphrase,
        },
        markets: opts.conditionIds,
        type: "user",
      }),
    );
    pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send("PING");
    }, PING_INTERVAL_MS);
    opts.onOpen?.();
  };
  ws.onmessage = (ev: MessageEvent) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    if (!data || data === "PONG") return;
    try {
      const parsed = JSON.parse(data) as UserWsMessage | UserWsMessage[];
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      for (const msg of msgs) {
        if (msg.event_type === "order") opts.onOrder(msg);
        else if (msg.event_type === "trade") opts.onTrade(msg);
        // Unknown event types are ignored until verified against a live session.
      }
    } catch (err) {
      opts.onError?.(err);
    }
  };
  ws.onerror = (ev) => opts.onError?.(ev);
  ws.onclose = () => {
    stopPing();
    opts.onClose?.();
  };

  return {
    close: () => {
      stopPing();
      ws.close();
    },
  };
}
