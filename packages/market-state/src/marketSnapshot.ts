import type {
  Freshness,
  MarketDescriptor,
  MarketSnapshot,
  OrderBook,
} from "@polyterminal/types";
import { bestAsk, bestBid, midpoint, spread } from "./orderBook";

export interface BuildSnapshotInput {
  market: MarketDescriptor;
  yesBook: OrderBook | null;
  noBook: OrderBook | null;
  btcReference: number | null;
  fairValue: number | null;
  score?: number | null;
  now?: number;
}

const FRESH_MAX_SEC = 30;
const QUIET_MAX_SEC = 120;

function classifyFreshness(ageSec: number | null): Freshness {
  if (ageSec === null) return "stale";
  if (ageSec <= FRESH_MAX_SEC) return "fresh";
  if (ageSec <= QUIET_MAX_SEC) return "quiet";
  return "stale";
}

export function buildSnapshot(input: BuildSnapshotInput): MarketSnapshot {
  const now = input.now ?? Date.now();
  const mid = midpoint(input.yesBook);
  const dislocation =
    input.fairValue !== null && mid !== null ? mid - input.fairValue : null;
  const bookUpdatedAt = input.yesBook?.timestamp ?? null;
  const bookAgeSec =
    bookUpdatedAt !== null ? Math.max(0, (now - bookUpdatedAt) / 1000) : null;
  return {
    market: input.market,
    yesBook: input.yesBook,
    noBook: input.noBook,
    midpointYes: mid,
    spreadYes: spread(input.yesBook),
    bestBidYes: bestBid(input.yesBook),
    bestAskYes: bestAsk(input.yesBook),
    btcReference: input.btcReference,
    fairValue: input.fairValue,
    dislocation,
    bookUpdatedAt,
    bookAgeSec,
    freshness: classifyFreshness(bookAgeSec),
    score: input.score ?? null,
    updatedAt: now,
  };
}
