"use client";

import * as React from "react";
import type { Freshness } from "@polyterminal/types";

export interface FreshnessBadgeProps {
  freshness: Freshness;
  ageSec: number | null;
}

const STYLES: Record<Freshness, { dot: string; text: string; label: string }> = {
  fresh: { dot: "bg-emerald-400", text: "text-emerald-300", label: "fresh" },
  quiet: { dot: "bg-amber-400", text: "text-amber-300", label: "quiet" },
  stale: { dot: "bg-rose-500", text: "text-rose-300", label: "stale" },
};

export function FreshnessBadge({ freshness, ageSec }: FreshnessBadgeProps) {
  const s = STYLES[freshness];
  const age = ageSec === null ? "—" : ageSec >= 60 ? `${(ageSec / 60).toFixed(1)}m` : `${ageSec.toFixed(0)}s`;
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider ${s.text}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label} · {age}
    </span>
  );
}
