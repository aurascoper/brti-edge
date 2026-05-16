import type { BookLevel, OrderBook } from "@polyterminal/types";
import { defaultEndpoints, getJson } from "../config";

interface RawBook {
  market: string;
  asset_id: string;
  timestamp: string | number;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

function toLevels(rows: Array<{ price: string; size: string }> | undefined): BookLevel[] {
  if (!rows) return [];
  return rows
    .map((r) => ({ price: Number(r.price), size: Number(r.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
}

export async function fetchBook(tokenId: string, endpoints = defaultEndpoints): Promise<OrderBook> {
  const url = `${endpoints.clob}/book?token_id=${encodeURIComponent(tokenId)}`;
  const raw = await getJson<RawBook>(url);
  const bids = toLevels(raw.bids).sort((a, b) => b.price - a.price);
  const asks = toLevels(raw.asks).sort((a, b) => a.price - b.price);
  const ts = typeof raw.timestamp === "string" ? Number(raw.timestamp) : raw.timestamp;
  return {
    tokenId,
    bids,
    asks,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
  };
}
