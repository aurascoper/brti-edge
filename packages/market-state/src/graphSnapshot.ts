import type { GraphEdge, GraphNode, GraphSnapshot, MarketSnapshot } from "@polyterminal/types";

export function buildGraph(primary: MarketSnapshot | null, related: MarketSnapshot[]): GraphSnapshot {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  if (primary) {
    nodes.push(toNode(primary, "primary"));
  }
  for (const m of related) {
    nodes.push(toNode(m, "related"));
    if (primary) {
      edges.push({
        source: primary.market.conditionId,
        target: m.market.conditionId,
        weight: edgeWeight(primary, m),
        kind: classifyEdge(primary, m),
      });
    }
  }
  return { nodes, edges };
}

function toNode(m: MarketSnapshot, group: string): GraphNode {
  const vol = m.market.volume24h ?? 0;
  return {
    id: m.market.conditionId,
    label: m.market.question,
    group,
    size: Math.max(4, Math.log10(Math.max(vol, 10)) * 4),
    midpoint: m.midpointYes,
  };
}

function edgeWeight(a: MarketSnapshot, b: MarketSnapshot): number {
  if (!a.market.endDateIso || !b.market.endDateIso) return 0.1;
  const da = Date.parse(a.market.endDateIso);
  const db = Date.parse(b.market.endDateIso);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0.1;
  const dayDiff = Math.abs(da - db) / 86_400_000;
  return Math.max(0.05, 1 / (1 + dayDiff));
}

function classifyEdge(a: MarketSnapshot, b: MarketSnapshot): GraphEdge["kind"] {
  const sharedTags = a.market.tags.filter((t) => b.market.tags.includes(t));
  if (sharedTags.length >= 2) return "shared-event";
  if (a.market.endDateIso && b.market.endDateIso) {
    const dayDiff =
      Math.abs(Date.parse(a.market.endDateIso) - Date.parse(b.market.endDateIso)) / 86_400_000;
    if (dayDiff < 3) return "expiry-near";
  }
  return "btc-thesis";
}
