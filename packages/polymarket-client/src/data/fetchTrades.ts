import { defaultEndpoints, getJson } from "../config";

export interface DataApiTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  outcome: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  timestamp: number;
  transactionHash: string;
}

export interface FetchTradesParams {
  user: string;
  limit?: number;
  offset?: number;
  market?: string;
}

export async function fetchTrades(
  params: FetchTradesParams,
  endpoints = defaultEndpoints,
): Promise<DataApiTrade[]> {
  const q = new URLSearchParams();
  q.set("user", params.user);
  q.set("limit", String(params.limit ?? 50));
  if (params.offset) q.set("offset", String(params.offset));
  if (params.market) q.set("market", params.market);
  const url = `${endpoints.data}/trades?${q.toString()}`;
  return getJson<DataApiTrade[]>(url);
}
