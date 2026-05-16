import type { TerminalSnapshot, TimePoint } from "@polyterminal/types";
import type { ForceEdge, ForceNode } from "../components/MarketForceGraph";

export function toMidpointSeries(snap: TerminalSnapshot | null): TimePoint[] {
  return snap?.primarySeries.midpointYes ?? [];
}

export function toBtcSeries(snap: TerminalSnapshot | null): TimePoint[] {
  return snap?.primarySeries.btcReference ?? [];
}

export function toEquitySeries(snap: TerminalSnapshot | null): TimePoint[] {
  return snap?.equitySeries ?? [];
}

export function toGraph(snap: TerminalSnapshot | null): { nodes: ForceNode[]; edges: ForceEdge[] } {
  const nodes: ForceNode[] = (snap?.graph.nodes ?? []).map((n) => ({
    id: n.id,
    label: n.label,
    group: n.group,
    size: n.size,
    midpoint: n.midpoint,
  }));
  const edges: ForceEdge[] = (snap?.graph.edges ?? []).map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    kind: e.kind,
  }));
  return { nodes, edges };
}
