import { defaultEndpoints, getJson } from "../config";
import type { GammaEventMarket } from "./fetchEvents";

export interface FetchMarketsParams {
  closed?: boolean;
  active?: boolean;
  limit?: number;
  offset?: number;
  conditionIds?: string[];
}

export async function fetchMarkets(
  params: FetchMarketsParams = {},
  endpoints = defaultEndpoints,
): Promise<GammaEventMarket[]> {
  const q = new URLSearchParams();
  if (params.closed !== undefined) q.set("closed", String(params.closed));
  if (params.active !== undefined) q.set("active", String(params.active));
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));
  if (params.conditionIds?.length) {
    for (const id of params.conditionIds) q.append("condition_ids", id);
  }
  const url = `${endpoints.gamma}/markets?${q.toString()}`;
  return getJson<GammaEventMarket[]>(url);
}
