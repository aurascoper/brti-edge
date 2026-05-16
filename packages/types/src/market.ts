export type OutcomeSide = "YES" | "NO";

export interface OutcomeToken {
  tokenId: string;
  outcome: string;
  price: number;
}

export interface MarketDescriptor {
  conditionId: string;
  slug: string;
  question: string;
  endDateIso: string | null;
  closed: boolean;
  active: boolean;
  tokens: OutcomeToken[];
  volume24h: number | null;
  liquidity: number | null;
  tags: string[];
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: number;
}

export interface TradePrint {
  tokenId: string;
  price: number;
  size: number;
  side: OutcomeSide;
  timestamp: number;
}

export type Freshness = "fresh" | "quiet" | "stale";

export interface MarketSnapshot {
  market: MarketDescriptor;
  yesBook: OrderBook | null;
  noBook: OrderBook | null;
  midpointYes: number | null;
  spreadYes: number | null;
  bestBidYes: number | null;
  bestAskYes: number | null;
  btcReference: number | null;
  fairValue: number | null;
  dislocation: number | null;
  bookUpdatedAt: number | null;
  bookAgeSec: number | null;
  freshness: Freshness;
  score: number | null;
  updatedAt: number;
}
