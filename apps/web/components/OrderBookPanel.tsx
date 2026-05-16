"use client";

import type { TerminalSnapshot } from "@polyterminal/types";
import { Card, FreshnessBadge, OrderBookTable, Stat, formatPrice } from "@polyterminal/ui";
import { topNImbalance } from "@polyterminal/signals";

export function OrderBookPanel({ snap }: { snap: TerminalSnapshot | null }) {
  const primary = snap?.primary;
  const book = primary?.yesBook ?? null;
  const imb = topNImbalance(book, 5);
  return (
    <Card
      title="orderbook · YES"
      right={
        <div className="flex items-center gap-3">
          {primary && (
            <FreshnessBadge freshness={primary.freshness} ageSec={primary.bookAgeSec} />
          )}
          <Stat
            label="imb"
            value={imb !== null ? imb.toFixed(2) : "—"}
            tone={imb === null ? "default" : imb > 0 ? "up" : imb < 0 ? "down" : "default"}
          />
          <Stat label="bid" value={formatPrice(primary?.bestBidYes ?? null)} tone="up" />
          <Stat label="ask" value={formatPrice(primary?.bestAskYes ?? null)} tone="down" />
        </div>
      }
    >
      <OrderBookTable book={book} depth={10} />
    </Card>
  );
}
