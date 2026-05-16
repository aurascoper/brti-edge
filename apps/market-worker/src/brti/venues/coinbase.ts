// Coinbase Exchange public market data adapter.
//
// Phase 1 (this file): REST polling at 1s cadence. Public Coinbase API:
//   GET https://api.exchange.coinbase.com/products/{symbol}-USD/book?level=1
//   Returns { bids: [[price, size, num-orders]], asks: [[price, size, num-orders]] }
//
// Phase 2 (later): WebSocket level2 feed at wss://ws-feed.exchange.coinbase.com
//   Subscribe channels=[{ name: "level2", product_ids: ["BTC-USD", ...] }]
//   Required for true second-by-second OFI on top-5 depth.
//
// Rate limit: Coinbase public API is ~10 req/s per IP. We poll each symbol
// every 1s so 7 symbols = ~7 req/s total, comfortably under limit.

import type { Symbol, VenueAdapter, VenueTick } from "../types";

const SYMBOL_MAP: Record<Symbol, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  BNB: "BNB-USD",       // BNB is not listed on Coinbase US — adapter will skip
  DOGE: "DOGE-USD",
  XRP: "XRP-USD",
  HYPE: "HYPE-USD",     // HYPE listing varies — adapter will skip if 404
};

export class CoinbaseAdapter implements VenueAdapter {
  venue = "coinbase";
  symbols: Symbol[];
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(symbols: Symbol[]) {
    this.symbols = symbols.filter((s) => SYMBOL_MAP[s] !== undefined);
  }

  async start(onTick: (t: VenueTick) => void): Promise<void> {
    for (const sym of this.symbols) {
      const product = SYMBOL_MAP[sym];
      const poll = async () => {
        if (this.stopped) return;
        try {
          const r = await fetch(
            `https://api.exchange.coinbase.com/products/${product}/book?level=1`,
          );
          if (!r.ok) return;
          const j = (await r.json()) as {
            bids?: Array<[string, string, number]>;
            asks?: Array<[string, string, number]>;
          };
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
          // transient — silent
        }
      };
      // staggered start to spread API load across the 1s window
      setTimeout(() => {
        void poll();
        const interval = setInterval(poll, 1000);
        this.timers.push(interval);
      }, Math.random() * 1000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
