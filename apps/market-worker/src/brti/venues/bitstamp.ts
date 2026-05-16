// Bitstamp public market data adapter (Phase 1: REST polling).
//
// REST: GET https://www.bitstamp.net/api/v2/order_book/{pair}/?group=1
//   Pair codes lowercase (btcusd, ethusd, etc.). Returns { bids, asks }.
//
// Phase 2: wss://ws.bitstamp.net subscribed to order_book_<pair>.

import type { Symbol, VenueAdapter, VenueTick } from "../types";

const PAIR_MAP: Partial<Record<Symbol, string>> = {
  BTC: "btcusd",
  ETH: "ethusd",
  SOL: "solusd",
  DOGE: "dogeusd",
  XRP: "xrpusd",
  // BNB, HYPE not on Bitstamp
};

export class BitstampAdapter implements VenueAdapter {
  venue = "bitstamp";
  symbols: Symbol[];
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(symbols: Symbol[]) {
    this.symbols = symbols.filter((s) => PAIR_MAP[s] !== undefined);
  }

  async start(onTick: (t: VenueTick) => void): Promise<void> {
    for (const sym of this.symbols) {
      const pair = PAIR_MAP[sym]!;
      const poll = async () => {
        if (this.stopped) return;
        try {
          const r = await fetch(`https://www.bitstamp.net/api/v2/order_book/${pair}/`);
          if (!r.ok) return;
          const j = (await r.json()) as { bids?: Array<[string, string]>; asks?: Array<[string, string]> };
          const b = j.bids?.[0];
          const a = j.asks?.[0];
          if (!b || !a) return;
          onTick({
            venue: this.venue,
            symbol: sym,
            bid: Number(b[0]),
            ask: Number(a[0]),
            bid_size: Number(b[1]),
            ask_size: Number(a[1]),
            ts_ms: Date.now(),
          });
        } catch {
          // silent
        }
      };
      setTimeout(() => {
        void poll();
        this.timers.push(setInterval(poll, 1000));
      }, Math.random() * 1000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
