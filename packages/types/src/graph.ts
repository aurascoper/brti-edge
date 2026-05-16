export interface GraphNode {
  id: string;
  label: string;
  group: string;
  size: number;
  midpoint: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  kind: "shared-event" | "expiry-near" | "correlation" | "btc-thesis";
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
