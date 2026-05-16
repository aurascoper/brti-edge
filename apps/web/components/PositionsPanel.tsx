"use client";

import { useAccount } from "wagmi";
import { Card, formatPrice, formatUsd } from "@polyterminal/ui";
import { usePolymarketPositions } from "../hooks/usePolymarketAccount";
import { useFunder } from "../hooks/useFunder";
import type { DataApiPosition } from "@polyterminal/polymarket-client";

export function PositionsPanel() {
  const { isConnected } = useAccount();
  const funder = useFunder();
  const { positions, isLoading } = usePolymarketPositions(funder.funderAddress);

  if (!isConnected) {
    return (
      <Card title="positions">
        <div className="flex h-full items-center justify-center text-xs text-zinc-600">
          connect wallet
        </div>
      </Card>
    );
  }

  const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
  const totalPnl = positions.reduce((s, p) => s + p.cashPnl, 0);

  return (
    <Card
      title="positions"
      right={
        <div className="flex gap-3 font-mono text-[10px] text-zinc-500">
          <span>n={positions.length}</span>
          <span>val {formatUsd(totalValue)}</span>
          <span className={totalPnl > 0 ? "text-emerald-300" : totalPnl < 0 ? "text-rose-300" : ""}>
            pnl {formatUsd(totalPnl)}
          </span>
        </div>
      }
    >
      {isLoading && positions.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-zinc-600">
          loading positions…
        </div>
      ) : positions.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-zinc-600">
          no positions
        </div>
      ) : (
        <div className="flex h-full flex-col gap-1 overflow-y-auto pr-1">
          {positions.map((p) => (
            <PositionRow key={`${p.conditionId}-${p.outcomeIndex}`} pos={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

function PositionRow({ pos }: { pos: DataApiPosition }) {
  const pnlTone =
    pos.cashPnl > 0 ? "text-emerald-300" : pos.cashPnl < 0 ? "text-rose-300" : "text-zinc-300";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[11px]">
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 leading-tight text-zinc-200" title={pos.title}>
          {pos.title}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
            pos.outcome.toLowerCase() === "yes"
              ? "bg-emerald-950 text-emerald-300"
              : "bg-rose-950 text-rose-300"
          }`}
        >
          {pos.outcome}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-4 gap-2 text-[10px] text-zinc-500">
        <span>sz {pos.size.toFixed(0)}</span>
        <span>avg {formatPrice(pos.avgPrice, 3)}</span>
        <span>now {formatPrice(pos.curPrice, 3)}</span>
        <span className={pnlTone}>{formatUsd(pos.cashPnl)}</span>
      </div>
    </div>
  );
}
