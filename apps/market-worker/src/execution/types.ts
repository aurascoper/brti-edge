export type DustCandidateStatus =
  | "pending_confirm" // requires manual approve before live submit
  | "approved" // ready to submit (still requires browser to actually sign+submit)
  | "submitted" // browser has reported submission
  | "filled"
  | "rejected"
  | "expired"
  | "declined"
  | "dry_run"; // policy approved but live mode disabled

export interface DustCandidateStamps {
  strategy: string;
  bookAgeSec: number | null;
  btcDriftBps: number | null;
  sigmaAnnual: number | null;
  midYes: number | null;
  decisionReason: string;
}

export interface DustCandidate {
  id: string;
  createdAt: number;
  marketId: string;
  marketSlug: string;
  horizon: "5m" | "15m" | "other";
  side: "YES" | "NO";
  price: number;
  size: number;
  notional: number;
  edge: number;
  expiresAt: number;
  status: DustCandidateStatus;
  policyDecision: PolicyDecision;
  stamps: DustCandidateStamps;
  test?: boolean;
  signedOrderId?: string | null;
  realizedPnl?: number | null;
}

export interface PolicyDecision {
  approved: boolean;
  reasons: string[];
  cappedSize: number;
  requiresManualConfirm: boolean;
}

export interface DustPolicyConfig {
  enabled: boolean;
  live: boolean;
  strategiesAllowed: string[];
  sidesAllowed: ("YES" | "NO")[];
  horizonsAllowed: ("5m" | "15m" | "other")[];
  maxNotionalUsd: number;
  maxTradesTotal: number;
  manualConfirmFirstN: number;
  hardStopPnl: number;
  maxBtcDriftBps: number;
  freshnessMaxSec: number;
  candidateTtlSec: number;
  minOrderSize: number;
}

export interface DustState {
  candidates: DustCandidate[];
  tradesSubmittedTotal: number;
  cumulativePnl: number;
  inFlightId: string | null;
}
