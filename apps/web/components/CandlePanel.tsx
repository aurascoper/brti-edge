"use client";

import type { TerminalSnapshot } from "@polyterminal/types";
import { Card, CandleChart, FreshnessBadge, formatPrice } from "@polyterminal/ui";
import { toMidpointSeries } from "../lib/chartTransforms";

export function CandlePanel({ snap }: { snap: TerminalSnapshot | null }) {
  const primary = snap?.primary;
  const series = toMidpointSeries(snap);
  return (
    <Card
      title="midpoint · YES"
      right={
        primary ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-zinc-100">
              {formatPrice(primary.midpointYes)}
            </span>
            <FreshnessBadge freshness={primary.freshness} ageSec={primary.bookAgeSec} />
          </div>
        ) : null
      }
    >
      <div className="h-full w-full">
        {series.length > 1 ? (
          <CandleChart series={series} height={320} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            warming up · {series.length} pts
          </div>
        )}
      </div>
    </Card>
  );
}
