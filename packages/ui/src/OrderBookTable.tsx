import * as React from "react";
import type { OrderBook } from "@polyterminal/types";
import { formatPrice, formatSize } from "./format";

export interface OrderBookTableProps {
  book: OrderBook | null;
  depth?: number;
}

export function OrderBookTable({ book, depth = 10 }: OrderBookTableProps) {
  const bids = (book?.bids ?? []).slice(0, depth);
  const asks = (book?.asks ?? []).slice(0, depth).reverse();
  return (
    <div className="grid grid-cols-2 gap-3 font-mono text-xs">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Bids</div>
        {bids.map((l, i) => (
          <div key={`b-${i}`} className="flex justify-between text-emerald-400">
            <span>{formatPrice(l.price)}</span>
            <span className="text-zinc-300">{formatSize(l.size)}</span>
          </div>
        ))}
        {bids.length === 0 && <div className="text-zinc-600">—</div>}
      </div>
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Asks</div>
        {asks.map((l, i) => (
          <div key={`a-${i}`} className="flex justify-between text-rose-400">
            <span>{formatPrice(l.price)}</span>
            <span className="text-zinc-300">{formatSize(l.size)}</span>
          </div>
        ))}
        {asks.length === 0 && <div className="text-zinc-600">—</div>}
      </div>
    </div>
  );
}
