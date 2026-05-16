export interface PolymarketEndpoints {
  gamma: string;
  clob: string;
  data: string;
  ws: string;
}

export const defaultEndpoints: PolymarketEndpoints = {
  gamma: process.env.POLYMARKET_GAMMA_BASE ?? "https://gamma-api.polymarket.com",
  clob: process.env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com",
  data: process.env.POLYMARKET_DATA_BASE ?? "https://data-api.polymarket.com",
  ws: process.env.POLYMARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/",
};

export class PolymarketHttpError extends Error {
  constructor(public status: number, public url: string, public body: string) {
    super(`Polymarket ${status} on ${url}: ${body.slice(0, 200)}`);
    this.name = "PolymarketHttpError";
  }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PolymarketHttpError(res.status, url, text);
  }
  return (await res.json()) as T;
}
