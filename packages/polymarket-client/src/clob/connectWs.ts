import { defaultEndpoints } from "../config";

export type MarketWsMessage =
  | { event_type: "book"; asset_id: string; market: string; timestamp: string; bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> }
  | { event_type: "price_change"; asset_id: string; market: string; changes: Array<{ price: string; side: "BUY" | "SELL"; size: string }>; timestamp: string }
  | { event_type: "tick_size_change"; asset_id: string; market: string; old_tick_size: string; new_tick_size: string; timestamp: string }
  | { event_type: "last_trade_price"; asset_id: string; market: string; price: string; size: string; side: "BUY" | "SELL"; timestamp: string };

export interface MarketWsHandle {
  close: () => void;
}

export interface ConnectMarketWsOptions {
  assetIds: string[];
  onMessage: (msg: MarketWsMessage) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
  endpoints?: typeof defaultEndpoints;
  WebSocketCtor?: typeof WebSocket;
}

export function connectMarketWs(opts: ConnectMarketWsOptions): MarketWsHandle {
  const endpoints = opts.endpoints ?? defaultEndpoints;
  const Ctor = opts.WebSocketCtor ?? (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
  if (!Ctor) throw new Error("WebSocket constructor unavailable; pass WebSocketCtor explicitly in Node");

  const url = `${endpoints.ws.replace(/\/$/, "")}/market`;
  const ws = new Ctor(url);

  ws.onopen = () => {
    ws.send(JSON.stringify({ assets_ids: opts.assetIds, type: "market" }));
    opts.onOpen?.();
  };
  ws.onmessage = (ev: MessageEvent) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    if (!data || data === "PONG") return;
    try {
      const parsed = JSON.parse(data) as MarketWsMessage | MarketWsMessage[];
      if (Array.isArray(parsed)) parsed.forEach(opts.onMessage);
      else opts.onMessage(parsed);
    } catch (err) {
      opts.onError?.(err);
    }
  };
  ws.onerror = (ev) => opts.onError?.(ev);
  ws.onclose = () => opts.onClose?.();

  return { close: () => ws.close() };
}
