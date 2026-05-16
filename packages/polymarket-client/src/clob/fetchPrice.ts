import { defaultEndpoints, getJson } from "../config";

interface PriceResponse {
  price: string;
}

export async function fetchPrice(
  tokenId: string,
  side: "BUY" | "SELL",
  endpoints = defaultEndpoints,
): Promise<number | null> {
  const url = `${endpoints.clob}/price?token_id=${encodeURIComponent(tokenId)}&side=${side}`;
  const raw = await getJson<PriceResponse>(url);
  const n = Number(raw.price);
  return Number.isFinite(n) ? n : null;
}
