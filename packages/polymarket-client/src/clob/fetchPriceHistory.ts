import { defaultEndpoints, getJson } from "../config";

export interface PriceHistoryPoint {
  t: number;
  p: number;
}

interface RawHistory {
  history: Array<{ t: number; p: number | string }>;
}

export type HistoryInterval = "1m" | "1h" | "6h" | "1d" | "1w" | "max";

export async function fetchPriceHistory(
  marketTokenId: string,
  opts: { interval?: HistoryInterval; fidelity?: number; startTs?: number; endTs?: number } = {},
  endpoints = defaultEndpoints,
): Promise<PriceHistoryPoint[]> {
  const q = new URLSearchParams({ market: marketTokenId });
  if (opts.interval) q.set("interval", opts.interval);
  if (opts.fidelity) q.set("fidelity", String(opts.fidelity));
  if (opts.startTs) q.set("startTs", String(opts.startTs));
  if (opts.endTs) q.set("endTs", String(opts.endTs));
  const url = `${endpoints.clob}/prices-history?${q.toString()}`;
  const raw = await getJson<RawHistory>(url);
  return (raw.history ?? [])
    .map((row) => ({ t: row.t, p: Number(row.p) }))
    .filter((row) => Number.isFinite(row.p));
}
