import type { OrderBook } from "@polyterminal/types";
import { spread } from "@polyterminal/market-state";

export interface SpreadHistory {
  values: number[];
  capacity: number;
}

export function makeHistory(capacity = 60): SpreadHistory {
  return { values: [], capacity };
}

export function pushSpread(h: SpreadHistory, book: OrderBook | null): SpreadHistory {
  const s = spread(book);
  if (s === null) return h;
  const next = [...h.values, s];
  if (next.length > h.capacity) next.shift();
  return { ...h, values: next };
}

export function compressionScore(h: SpreadHistory): number | null {
  if (h.values.length < 5) return null;
  const recent = h.values[h.values.length - 1]!;
  const sorted = [...h.values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median === 0) return null;
  return 1 - recent / median;
}
