// BRTI (Bitcoin Real-Time Index) aggregator types.
//
// CF Benchmarks publishes BRTI as a once-per-second consolidated benchmark
// across constituent venues. Kalshi crypto 15-min markets settle on the
// simple mean of 60 BRTI samples in the final minute before resolution.
// Our local synthetic-BRTI aggregator replicates that calculation from
// public WebSocket / REST feeds across the same constituent set.
//
// Known constituents (2026-Q2):
//   - Coinbase
//   - Kraken
//   - Bitstamp
//   - Gemini
//   - itBit
//   - LMAX Digital
//   - Bullish      (added 2024-12-30)
//   - Crypto.com   (added 2025-03-31)
//
// The exact aggregation rule + outlier filter that CF Benchmarks uses is
// proprietary; our proxy uses a robust trimmed mean of constituent mid
// prices, which is empirically close to the published BRTI within a few bps.

export type Symbol = "BTC" | "ETH" | "SOL" | "BNB" | "DOGE" | "XRP" | "HYPE";

export interface VenueTick {
  venue: string;     // canonical venue name (e.g., "coinbase")
  symbol: Symbol;
  bid: number;       // top-of-book bid in USD
  ask: number;       // top-of-book ask in USD
  bid_size: number;  // size at top bid (in base currency)
  ask_size: number;  // size at top ask
  ts_ms: number;     // local epoch ms when tick was observed
}

// 1-second synthetic-BRTI snapshot.
export interface BrtiSnapshot {
  symbol: Symbol;
  price: number;            // benchmark price (trimmed mean of constituent mids)
  ts_ms: number;
  contributors: string[];   // venues that contributed to this snapshot
  raw_mids: Record<string, number>; // per-venue mid for audit
}

// Order-flow imbalance features computed across constituent venues.
// Used as drift input in the new fair-value formula:
//   μ̂ = β₀ + β₁·OFI(1:5) + β₂·Δbasis + β₃·r(1,5,15) + β₄·1{regime}
export interface OfiFeatures {
  symbol: Symbol;
  ts_ms: number;
  top1_imbalance: number;     // (bid_size - ask_size) / (bid_size + ask_size), top-of-book
  top5_imbalance: number;     // same metric across top 5 levels (when depth available)
  aggressor_flow_1s: number;  // signed taker-flow in last 1s (positive = buy aggressor)
  trade_count_1s: number;
}

export interface VenueAdapter {
  venue: string;
  symbols: Symbol[];
  start(onTick: (t: VenueTick) => void): Promise<void>;
  stop(): Promise<void>;
}
