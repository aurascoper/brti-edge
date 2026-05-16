export type Side = "YES" | "NO" | "SKIP";

export interface TickPoint {
  ts: number;
  price: number;
}

export interface DecisionInput {
  marketId: string;
  marketSlug: string;
  endDateMs: number;
  tStartMs: number | null;
  nowMs: number;
  midYes: number | null;
  bestBidYes: number | null;
  bestAskYes: number | null;
  bookAgeSec: number | null;
  btcRef: number | null;
  btcTape: TickPoint[];
  sRef: number | null;
  sCurrent: number | null;
  sigmaAnnual: number | null;
}

export interface Decision {
  side: Side;
  size: number;
  price: number | null;
  reason: string;
}

export interface Strategy {
  name: string;
  decide(input: DecisionInput): Decision;
}

export interface DecisionRow {
  ts: string;
  marketId: string;
  marketSlug: string;
  endDate: string;
  tStart: string | null;
  secsToExpiry: number;
  midYes: number | null;
  bestBidYes: number | null;
  bestAskYes: number | null;
  spreadBps: number | null;
  bookAgeSec: number | null;
  btcRef: number | null;
  sRef: number | null;
  sCurrent: number | null;
  sigmaAnnual: number | null;
  decisions: Record<string, Decision>;
}

export interface OutcomeRow {
  ts: string;
  marketId: string;
  marketSlug: string;
  resolvedYes: 0 | 1;
  pnlByStrategy: Record<string, number>;
  decision: DecisionRow;
}
