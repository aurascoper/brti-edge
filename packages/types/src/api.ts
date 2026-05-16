import type { MarketSnapshot } from "./market";
import type { GraphSnapshot } from "./graph";

export interface TimePoint {
  ts: number;
  value: number;
}

export interface PrimarySeries {
  midpointYes: TimePoint[];
  btcReference: TimePoint[];
  spreadYes: TimePoint[];
}

export interface TerminalSnapshot {
  primary: MarketSnapshot | null;
  watchlist: MarketSnapshot[];
  related: MarketSnapshot[];
  graph: GraphSnapshot;
  primarySeries: PrimarySeries;
  equitySeries: TimePoint[];
  primaryScore: number | null;
  primaryMode: "auto" | "manual";
  manualPrimaryConditionId: string | null;
  updatedAt: number;
}

export interface RankedMarketBrief {
  conditionId: string;
  slug: string;
  question: string;
  yesPrice: number;
  score: number;
  volume24h: number | null;
  liquidity: number | null;
}

export interface ErrorEnvelope {
  error: string;
  detail?: string;
}
