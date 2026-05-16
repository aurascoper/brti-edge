export type OrderSide = "BUY" | "SELL";
export type OrderType = "GTC" | "FOK" | "FAK";

export interface Position {
  conditionId: string;
  tokenId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface OpenOrder {
  orderId: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  filled: number;
  type: OrderType;
  createdAt: number;
}

export interface TraderSnapshot {
  wallet: string | null;
  positions: Position[];
  openOrders: OpenOrder[];
  realizedPnl: number;
  unrealizedPnl: number;
}
