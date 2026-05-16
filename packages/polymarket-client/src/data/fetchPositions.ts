import { defaultEndpoints, getJson } from "../config";

export interface DataApiPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string | null;
  icon?: string;
}

export interface FetchPositionsParams {
  user: string;
  limit?: number;
  offset?: number;
  sortBy?: "CURRENT" | "INITIAL" | "TITLE";
  sortDirection?: "ASC" | "DESC";
  sizeThreshold?: number;
  redeemable?: boolean;
}

export async function fetchPositions(
  params: FetchPositionsParams,
  endpoints = defaultEndpoints,
): Promise<DataApiPosition[]> {
  const q = new URLSearchParams();
  q.set("user", params.user);
  q.set("limit", String(params.limit ?? 50));
  if (params.offset) q.set("offset", String(params.offset));
  if (params.sortBy) q.set("sortBy", params.sortBy);
  if (params.sortDirection) q.set("sortDirection", params.sortDirection);
  if (params.sizeThreshold !== undefined) q.set("sizeThreshold", String(params.sizeThreshold));
  if (params.redeemable !== undefined) q.set("redeemable", String(params.redeemable));
  const url = `${endpoints.data}/positions?${q.toString()}`;
  return getJson<DataApiPosition[]>(url);
}
