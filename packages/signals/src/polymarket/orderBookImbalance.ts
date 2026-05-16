import type { OrderBook } from "@polyterminal/types";

export function topNImbalance(book: OrderBook | null | undefined, depth = 5): number | null {
  if (!book) return null;
  const bidVol = book.bids.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const askVol = book.asks.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const total = bidVol + askVol;
  if (total === 0) return null;
  return (bidVol - askVol) / total;
}
