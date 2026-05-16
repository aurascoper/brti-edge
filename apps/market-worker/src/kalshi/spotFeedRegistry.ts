// One SpotFeed per CEX symbol. Lazy start: a feed is instantiated and started
// only when first requested. All feeds share the same polling interval and
// the same Binance.US REST base.
//
// Used by the scan loop to look up the right underlying spot for each series:
//   KXBTC15M   → BTCUSDT
//   KXETH15M   → ETHUSDT
//   KXSOL15M   → SOLUSDT
//   ... etc.

import { SpotFeed } from "./spotFeed";

export class SpotFeedRegistry {
  private readonly feeds = new Map<string, SpotFeed>();
  private readonly pollIntervalMs: number;

  constructor(pollIntervalMs = 3_000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  // Get-or-create a feed for the given CEX ticker (e.g. "BTCUSDT", "ETHUSDT").
  // First call also starts polling.
  get(symbol: string): SpotFeed {
    let f = this.feeds.get(symbol);
    if (f) return f;
    f = new SpotFeed(symbol);
    this.feeds.set(symbol, f);
    void f.start(this.pollIntervalMs);
    return f;
  }

  // Convenience: start all of the given symbols up front (fewer cold starts
  // on the first scan tick). Returns the registry for chaining.
  async preload(symbols: string[]): Promise<this> {
    // Just touching get() instantiates+starts. Await first poll for each.
    for (const s of symbols) this.get(s);
    // Give all feeds a beat to land their first poll before returning.
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs + 500));
    return this;
  }

  // Snapshot for diagnostics: which symbols have a usable spot right now?
  snapshot(): Array<{ symbol: string; spot: number | null; sigma: number | null; ageSec: number | null }> {
    const rows: Array<{ symbol: string; spot: number | null; sigma: number | null; ageSec: number | null }> = [];
    for (const [symbol, feed] of this.feeds) {
      rows.push({
        symbol,
        spot: feed.getSpot(),
        sigma: feed.getSigmaAnnual(),
        ageSec: feed.getTapeAgeSec(),
      });
    }
    return rows;
  }
}
