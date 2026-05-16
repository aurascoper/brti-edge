"use client";

import type { TerminalSnapshot } from "@polyterminal/types";
import { Card, formatPrice } from "@polyterminal/ui";

export function TapePanel({ snap }: { snap: TerminalSnapshot | null }) {
  const rows = (snap?.related ?? []).slice(0, 12);
  return (
    <Card title="related markets">
      <div className="grid grid-cols-1 gap-1 font-mono text-xs">
        <div className="grid grid-cols-[1fr_auto_auto] gap-3 text-[10px] uppercase tracking-wider text-zinc-500">
          <span>market</span>
          <span className="text-right">mid</span>
          <span className="text-right">vol</span>
        </div>
        {rows.map((m) => (
          <div key={m.market.conditionId} className="grid grid-cols-[1fr_auto_auto] gap-3">
            <span className="truncate text-zinc-300" title={m.market.question}>
              {m.market.question}
            </span>
            <span className="text-right text-zinc-100">{formatPrice(m.midpointYes)}</span>
            <span className="text-right text-zinc-500">
              {m.market.volume24h !== null ? Math.round(m.market.volume24h).toLocaleString() : "—"}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="text-zinc-600">no related markets yet</div>}
      </div>
    </Card>
  );
}
