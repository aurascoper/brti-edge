// Kalshi series catalog — short-horizon binary markets we can scan with fairValueArb.
//
// All entries are 15-minute strike-based digitals: YES resolves if the
// underlying settles at or above floor_strike at close. fairValueArb works
// uniformly on these with K = floor_strike.
//
// Execution-gating: `executionAllowed` defaults to false. Only BTC is enabled
// at Phase 2.2; once one full dust trade lands end-to-end on BTC, flip the
// other 8 to true (it's a one-line change). The scanner sees all of them
// either way — only order submission is gated.

export interface SeriesConfig {
  series: string; // Kalshi series_ticker
  underlying: string; // canonical "X-USD"
  cadenceSec: number; // length of each market window in seconds
  cexSpotSymbol: string; // for fairValueArb's CEX-implied price lookup (Binance-style ticker)
  executionAllowed: boolean; // gate at the venue/adapter layer
}

export const CRYPTO_15M_SERIES: SeriesConfig[] = [
  { series: "KXBTC15M", underlying: "BTC-USD", cadenceSec: 900, cexSpotSymbol: "BTCUSDT", executionAllowed: true },
  { series: "KXETH15M", underlying: "ETH-USD", cadenceSec: 900, cexSpotSymbol: "ETHUSDT", executionAllowed: true },
  { series: "KXSOL15M", underlying: "SOL-USD", cadenceSec: 900, cexSpotSymbol: "SOLUSDT", executionAllowed: true },
  { series: "KXBNB15M", underlying: "BNB-USD", cadenceSec: 900, cexSpotSymbol: "BNBUSDT", executionAllowed: true },
  { series: "KXDOGE15M", underlying: "DOGE-USD", cadenceSec: 900, cexSpotSymbol: "DOGEUSDT", executionAllowed: true },
  { series: "KXXRP15M", underlying: "XRP-USD", cadenceSec: 900, cexSpotSymbol: "XRPUSDT", executionAllowed: true },
  { series: "KXBCH15M", underlying: "BCH-USD", cadenceSec: 900, cexSpotSymbol: "BCHUSDT", executionAllowed: true },
  { series: "KXADA15M", underlying: "ADA-USD", cadenceSec: 900, cexSpotSymbol: "ADAUSDT", executionAllowed: true },
  { series: "KXHYPE15M", underlying: "HYPE-USD", cadenceSec: 900, cexSpotSymbol: "HYPEUSDT", executionAllowed: true },
];

export function seriesByTicker(seriesTicker: string): SeriesConfig | undefined {
  return CRYPTO_15M_SERIES.find((s) => s.series === seriesTicker);
}

// Convenience: derive series from a market ticker like "KXBTC15M-26MAY142215-15".
export function seriesFromMarketTicker(marketTicker: string): SeriesConfig | undefined {
  const prefix = marketTicker.split("-")[0];
  if (!prefix) return undefined;
  return seriesByTicker(prefix);
}

export function isExecutionAllowed(seriesTickerOrMarketTicker: string): boolean {
  const cfg =
    seriesByTicker(seriesTickerOrMarketTicker) ??
    seriesFromMarketTicker(seriesTickerOrMarketTicker);
  return cfg?.executionAllowed === true;
}
