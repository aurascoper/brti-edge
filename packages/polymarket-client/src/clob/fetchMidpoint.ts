import { defaultEndpoints, getJson } from "../config";

interface MidpointResponse {
  mid: string;
}

export async function fetchMidpoint(
  tokenId: string,
  endpoints = defaultEndpoints,
): Promise<number | null> {
  const url = `${endpoints.clob}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const raw = await getJson<MidpointResponse>(url);
  const n = Number(raw.mid);
  return Number.isFinite(n) ? n : null;
}
