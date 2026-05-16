"use client";

import * as React from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";

export interface ForceNode {
  id: string;
  label: string;
  group?: string;
  size?: number;
  midpoint?: number | null;
}

export interface ForceEdge {
  source: string;
  target: string;
  weight?: number;
  kind?: string;
}

export interface MarketForceGraphProps {
  nodes: ForceNode[];
  edges: ForceEdge[];
  selectedNodeId?: string | null;
  height?: number;
  onNodeClick?: (id: string) => void;
}

const COLORS: Record<string, string> = {
  primary: "#fbbf24",
  related: "#22d3ee",
  default: "#a1a1aa",
};

export function MarketForceGraph({
  nodes,
  edges,
  selectedNodeId = null,
  height = 320,
  onNodeClick,
}: MarketForceGraphProps) {
  const ref = React.useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [size, setSize] = React.useState<{ w: number; h: number }>({ w: 0, h: height });

  React.useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const observer = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight || height });
    });
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight || height });
    return () => observer.disconnect();
  }, [height]);

  const data = React.useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: edges.map((e) => ({ ...e })),
    }),
    [nodes, edges],
  );

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      {size.w > 0 && (
        <ForceGraph2D
          ref={ref}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={120}
          nodeRelSize={3}
          linkColor={() => "rgba(161,161,170,0.25)"}
          linkWidth={(link: any) => 0.5 + ((link?.weight as number | undefined) ?? 0.2) * 2}
          nodeVal={(node: any) => Math.max(1, (node?.size as number | undefined) ?? 4)}
          nodeLabel={(node: any) => {
            const label = (node?.label as string | undefined) ?? "";
            const mid = node?.midpoint as number | null | undefined;
            return `${label} · mid ${mid != null ? mid.toFixed(3) : "—"}`;
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as ForceNode & { x?: number; y?: number };
            if (n.x === undefined || n.y === undefined) return;
            const isSelected = n.id === selectedNodeId;
            const color = COLORS[n.group ?? "default"] ?? COLORS.default!;
            const r = Math.max(2, (n.size ?? 4) * 0.6);
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            if (isSelected) {
              ctx.lineWidth = 1.5 / globalScale;
              ctx.strokeStyle = "#fff";
              ctx.stroke();
            }
          }}
          onNodeClick={(node) => onNodeClick?.((node as ForceNode).id)}
        />
      )}
    </div>
  );
}
