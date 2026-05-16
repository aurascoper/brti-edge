import type { MarketSnapshot } from "@polyterminal/types";
import {
  buildOrderIntent,
  type OrderIntent,
  type OrderSide,
  type SupportedOrderType,
} from "@polyterminal/polymarket-client";
import type { Outcome, OrderType } from "./orderPreview";

export interface TicketInputs {
  side: OrderSide;
  outcome: Outcome;
  type: OrderType;
  size: number;
  executionPrice: number | null;
  primary: MarketSnapshot | null;
}

export function ticketToOrderIntent(input: TicketInputs): OrderIntent | null {
  if (!input.primary || input.executionPrice === null) return null;

  const yesToken = input.primary.market.tokens.find((t) => /yes/i.test(t.outcome));
  const noToken = input.primary.market.tokens.find((t) => /no/i.test(t.outcome));
  const target = input.outcome === "YES" ? yesToken : noToken;
  if (!target?.tokenId) return null;

  const orderType: SupportedOrderType = input.type === "marketable" ? "FAK" : "GTC";

  return buildOrderIntent({
    tokenId: target.tokenId,
    side: input.side,
    price: input.executionPrice,
    size: input.size,
    orderType,
    outcome: input.outcome,
  });
}
