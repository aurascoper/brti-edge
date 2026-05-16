"use client";

import dynamic from "next/dynamic";
import type { TerminalSnapshot } from "@polyterminal/types";
import { Card } from "@polyterminal/ui";
import { toGraph } from "../lib/chartTransforms";

const MarketForceGraph = dynamic(
  () => import("./MarketForceGraph").then((m) => ({ default: m.MarketForceGraph })),
  { ssr: false, loading: () => <div className="h-full w-full" /> },
);

export function NetworkGraphPanel({ snap }: { snap: TerminalSnapshot | null }) {
  const { nodes, edges } = toGraph(snap);
  const primaryId = snap?.primary?.market.conditionId ?? null;
  return (
    <Card
      title="market graph"
      right={
        <span className="text-[10px] text-zinc-500">
          {nodes.length} nodes · {edges.length} edges
        </span>
      }
    >
      <div className="h-full w-full">
        {nodes.length > 0 ? (
          <MarketForceGraph nodes={nodes} edges={edges} selectedNodeId={primaryId} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            graph empty
          </div>
        )}
      </div>
    </Card>
  );
}
