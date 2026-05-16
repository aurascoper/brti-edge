"use client";

import { Card, Stat } from "@polyterminal/ui";

export function PositionCard() {
  return (
    <Card title="position">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="wallet" value="—" hint="connect wallet (Milestone 2)" />
        <Stat label="size" value="0" />
        <Stat label="avg" value="—" />
        <Stat label="upnl" value="$0" />
      </div>
      <button
        type="button"
        disabled
        className="mt-3 w-full cursor-not-allowed rounded-md border border-zinc-800 bg-zinc-900 py-2 text-xs uppercase tracking-wider text-zinc-500"
      >
        order ticket disabled · read-only
      </button>
    </Card>
  );
}
