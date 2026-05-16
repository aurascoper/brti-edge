"use client";

import type { TerminalSnapshot } from "@polyterminal/types";
import { Card, LineChart, Stat } from "@polyterminal/ui";
import { toEquitySeries } from "../lib/chartTransforms";

export function PnlPanel({ snap }: { snap: TerminalSnapshot | null }) {
  const series = toEquitySeries(snap);
  const first = series[0]?.value ?? null;
  const last = series[series.length - 1]?.value ?? null;
  const delta = first !== null && last !== null ? last - first : null;
  return (
    <Card
      title="market curve · placeholder"
      right={
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          mid history (no account data yet)
        </span>
      }
    >
      <div className="grid h-full grid-rows-[auto_1fr]">
        <div className="grid grid-cols-3 gap-3 pb-2">
          <Stat label="first" value={first !== null ? first.toFixed(4) : "—"} />
          <Stat label="last" value={last !== null ? last.toFixed(4) : "—"} />
          <Stat
            label="Δ"
            value={delta !== null ? delta.toFixed(4) : "—"}
            tone={delta === null ? "default" : delta > 0 ? "up" : delta < 0 ? "down" : "default"}
          />
        </div>
        <div className="min-h-0">
          {series.length > 1 ? (
            <LineChart series={series} color="#22d3ee" height={120} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-zinc-600">
              warming up · {series.length} pts
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
