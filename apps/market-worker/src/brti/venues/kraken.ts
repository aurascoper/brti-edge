// Kraken public market data adapter (Phase 1: REST polling).
//
// REST: GET https://api.kraken.com/0/public/Depth?pair={KRAKEN_PAIR}&count=1
//   Returns { result: { "XXBTZUSD": { bids: [[p, v, ts]], asks: [...] } } }
//
// Phase 2: wss://ws.kraken.com book channel.
//
// Note: Kraken uses idiosyncratic pair codes (XXBTZUSD = BTC/USD, XETHZUSD = ETH/USD).

import type { Symbol, VenueAdapter, VenueTick } from "../types";

const PAIR_MAP: Partial<Record<Symbol, { req: string; res: string }>> = {
  BTC: { req: "XBTUSD", res: "XXBTZUSD" },
  ETH: { req: "ETHUSD", res: "XETHZUSD" },
  SOL: { req: "SOLUSD", res: "SOLUSD" },
  DOGE: { req: "XDGUSD", res: "XDGUSD" },
  XRP: { req: "XRPUSD", res: "XXRPZUSD" },
  // BNB and HYPE not listed on Kraken; intentionally omitted
};

export class KrakenAdapter implements VenueAdapter {
  venue = "kraken";
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
          const r = await fetch(
            `https://api.kraken.com/0/public/Depth?pair=${pair.req}&count=1`,
          );
          if (!r.ok) return;
          const j = (await r.json()) as {
            result?: Record<string, { bids?: Array<[string, string, number]>; asks?: Array<[string, string, number]> }>;
          };
          const book = j.result?.[pair.res] ?? Object.values(j.result ?? {})[0];
          if (!book) return;
          const b = book.bids?.[0];
          const a = book.asks?.[0];
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
