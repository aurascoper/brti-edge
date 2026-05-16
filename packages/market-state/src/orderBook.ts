import type { BookLevel, OrderBook } from "@polyterminal/types";

export function bestBid(book: OrderBook | null | undefined): number | null {
  return book?.bids[0]?.price ?? null;
}

export function bestAsk(book: OrderBook | null | undefined): number | null {
  return book?.asks[0]?.price ?? null;
}

export function midpoint(book: OrderBook | null | undefined): number | null {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (b === null || a === null) return null;
  return (b + a) / 2;
}

export function spread(book: OrderBook | null | undefined): number | null {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (b === null || a === null) return null;
  return a - b;
}

export interface PriceChange {
  price: string;
  size: string;
  side: "BUY" | "SELL";
}

function applySide(levels: BookLevel[], price: number, size: number, ascending: boolean): BookLevel[] {
  const next = levels.filter((l) => l.price !== price);
  if (size > 0) next.push({ price, size });
  next.sort((a, b) => (ascending ? a.price - b.price : b.price - a.price));
  return next;
}

export function applyPriceChanges(book: OrderBook, changes: PriceChange[], timestamp: number): OrderBook {
  let bids = book.bids;
  let asks = book.asks;
  for (const ch of changes) {
    const price = Number(ch.price);
    const size = Number(ch.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (ch.side === "BUY") bids = applySide(bids, price, size, false);
    else asks = applySide(asks, price, size, true);
  }
  return { ...book, bids, asks, timestamp };
}
