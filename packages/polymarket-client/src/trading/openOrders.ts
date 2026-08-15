import { ClobClient, type OpenOrder, type OpenOrderParams } from "@polymarket/clob-client-v2";

export interface FetchOpenOrdersParams {
  market?: string; // condition id
  assetId?: string; // CLOB token id
}

export interface NormalizedOpenOrder {
  orderId: string;
  status: string;
  market: string;
  assetId: string;
  side: "BUY" | "SELL";
  price: number;
  originalSize: number;
  sizeMatched: number;
  remaining: number;
  outcome: string;
  orderType: string;
  createdAt: number; // unix ms
  expiration: string | null;
  raw: OpenOrder;
}

export async function fetchOpenOrders(
  client: ClobClient,
  params: FetchOpenOrdersParams = {},
): Promise<NormalizedOpenOrder[]> {
  const sdkParams: OpenOrderParams = {};
  if (params.market !== undefined) sdkParams.market = params.market;
  if (params.assetId !== undefined) sdkParams.asset_id = params.assetId;
  const res = await client.getOpenOrders(sdkParams);
  const rows = Array.isArray(res) ? res : [];
  return rows.map(normalizeOpenOrder);
}

function normalizeOpenOrder(o: OpenOrder): NormalizedOpenOrder {
  const originalSize = Number(o.original_size);
  const sizeMatched = Number(o.size_matched);
  return {
    orderId: o.id,
    status: o.status,
    market: o.market,
    assetId: o.asset_id,
    side: o.side === "SELL" ? "SELL" : "BUY",
    price: Number(o.price),
    originalSize,
    sizeMatched,
    remaining: originalSize - sizeMatched,
    outcome: o.outcome,
    orderType: o.order_type,
    // created_at is unix seconds on the CLOB; tolerate ms just in case.
    createdAt: o.created_at > 1e12 ? o.created_at : o.created_at * 1000,
    expiration: o.expiration || null,
    raw: o,
  };
}
