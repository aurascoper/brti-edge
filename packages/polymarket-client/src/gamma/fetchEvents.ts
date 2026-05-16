import { defaultEndpoints, getJson } from "../config";

export interface GammaEventMarket {
  conditionId: string;
  questionID?: string;
  question: string;
  slug: string;
  endDate: string | null;
  closed: boolean;
  active: boolean;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  volume24hr?: number | string;
  liquidity?: number | string;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  ticker?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  tags?: Array<{ id: string; label: string; slug: string }>;
  markets?: GammaEventMarket[];
}

export interface FetchEventsParams {
  closed?: boolean;
  active?: boolean;
  limit?: number;
  offset?: number;
  tagSlug?: string;
  search?: string;
  order?: string;
  ascending?: boolean;
  startDateMin?: string;
}

export async function fetchEvents(
  params: FetchEventsParams = {},
  endpoints = defaultEndpoints,
): Promise<GammaEvent[]> {
  const q = new URLSearchParams();
  if (params.closed !== undefined) q.set("closed", String(params.closed));
  if (params.active !== undefined) q.set("active", String(params.active));
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));
  if (params.tagSlug) q.set("tag_slug", params.tagSlug);
  if (params.search) q.set("search", params.search);
  if (params.order) q.set("order", params.order);
  if (params.ascending !== undefined) q.set("ascending", String(params.ascending));
  if (params.startDateMin) q.set("start_date_min", params.startDateMin);

  const url = `${endpoints.gamma}/events?${q.toString()}`;
  return getJson<GammaEvent[]>(url);
}
