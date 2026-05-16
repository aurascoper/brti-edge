import * as React from "react";
import type { TradePrint } from "@polyterminal/types";
import { formatPrice, formatSize } from "./format";

export interface TradesTableProps {
  trades: TradePrint[];
  rows?: number;
}

export function TradesTable({ trades, rows = 30 }: TradesTableProps) {
  const slice = trades.slice(0, rows);
  return (
    <div className="font-mono text-xs">
      <div className="mb-1 grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Time</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
      </div>
      {slice.map((t, i) => (
        <div
          key={`${t.timestamp}-${i}`}
          className={`grid grid-cols-3 gap-2 ${t.side === "YES" ? "text-emerald-400" : "text-rose-400"}`}
        >
          <span className="text-zinc-400">{new Date(t.timestamp).toLocaleTimeString()}</span>
          <span className="text-right">{formatPrice(t.price)}</span>
          <span className="text-right text-zinc-300">{formatSize(t.size)}</span>
        </div>
      ))}
      {slice.length === 0 && <div className="text-zinc-600">no trades yet</div>}
    </div>
  );
}
