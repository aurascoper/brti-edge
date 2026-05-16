import type { MarketSnapshot } from "@polyterminal/types";

export type Side = "BUY" | "SELL";
export type Outcome = "YES" | "NO";
export type OrderType = "marketable" | "limit";

export interface PreviewInput {
  side: Side;
  outcome: Outcome;
  type: OrderType;
  size: number;
  limitPrice: number | null;
  primary: MarketSnapshot | null;
}

export interface PreviewOutput {
  ok: boolean;
  reason?: string;
  yesMid: number | null;
  refPrice: number | null;
  executionPrice: number | null;
  slippage: number | null;
  notional: number | null;
  shares: number;
  side: Side;
  outcome: Outcome;
  type: OrderType;
}

export function computePreview(input: PreviewInput): PreviewOutput {
  const { primary, side, outcome, type, size, limitPrice } = input;
  const yesMid = primary?.midpointYes ?? null;
  const yesBid = primary?.bestBidYes ?? null;
  const yesAsk = primary?.bestAskYes ?? null;

  const noMid = yesMid !== null ? 1 - yesMid : null;
  const noBid = yesAsk !== null ? 1 - yesAsk : null;
  const noAsk = yesBid !== null ? 1 - yesBid : null;

  const mid = outcome === "YES" ? yesMid : noMid;
  const bid = outcome === "YES" ? yesBid : noBid;
  const ask = outcome === "YES" ? yesAsk : noAsk;

  let refPrice: number | null = null;
  let executionPrice: number | null = null;

  if (type === "marketable") {
    refPrice = mid;
    executionPrice = side === "BUY" ? ask : bid;
  } else {
    refPrice = mid;
    executionPrice = limitPrice;
  }

  const ok =
    Number.isFinite(size) &&
    size > 0 &&
    executionPrice !== null &&
    Number.isFinite(executionPrice) &&
    executionPrice > 0 &&
    executionPrice < 1;

  const notional = ok && executionPrice !== null ? executionPrice * size : null;
  const slippage =
    executionPrice !== null && refPrice !== null ? Math.abs(executionPrice - refPrice) : null;

  const reason = !primary
    ? "no market"
    : size <= 0
      ? "size must be > 0"
      : executionPrice === null
        ? "no execution price"
        : executionPrice >= 1 || executionPrice <= 0
          ? "price out of (0,1)"
          : null;

  const out: PreviewOutput = {
    ok,
    yesMid,
    refPrice,
    executionPrice,
    slippage,
    notional,
    shares: size,
    side,
    outcome,
    type,
  };
  if (reason !== null) out.reason = reason;
  return out;
}

export function defaultLimitPrice(
  side: Side,
  outcome: Outcome,
  primary: MarketSnapshot | null,
): number | null {
  if (!primary) return null;
  const yesBid = primary.bestBidYes;
  const yesAsk = primary.bestAskYes;
  if (outcome === "YES") {
    return side === "BUY" ? yesAsk : yesBid;
  }
  if (yesBid === null || yesAsk === null) return null;
  return side === "BUY" ? 1 - yesBid : 1 - yesAsk;
}
