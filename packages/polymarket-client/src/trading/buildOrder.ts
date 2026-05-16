export type OrderSide = "BUY" | "SELL";
export type SupportedOrderType = "GTC" | "FAK";

export interface OrderIntent {
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  orderType: SupportedOrderType;
  feeRateBps: number;
  outcome: string;
}

export interface BuildOrderInput {
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  orderType: SupportedOrderType;
  outcome: string;
  feeRateBps?: number;
}

export function buildOrderIntent(input: BuildOrderInput): OrderIntent {
  return {
    tokenId: input.tokenId,
    side: input.side,
    price: roundPrice(input.price),
    size: roundSize(input.size),
    orderType: input.orderType,
    feeRateBps: input.feeRateBps ?? 0,
    outcome: input.outcome,
  };
}

function roundPrice(p: number): number {
  return Math.round(p * 10_000) / 10_000;
}

function roundSize(s: number): number {
  return Math.round(s * 100) / 100;
}
