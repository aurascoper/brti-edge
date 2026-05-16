// Kalshi worker state fetcher.
// The Kalshi scan loop exposes /kalshi/state on port 4001 (configurable).
// Distinct from the Polymarket worker on :4000.

export function kalshiWorkerUrl(): string {
  return process.env.NEXT_PUBLIC_KALSHI_WORKER_URL ?? "http://localhost:4001";
}

export interface KalshiSeriesConfig {
  series: string;
  underlying: string;
  cadenceSec: number;
  cexSpotSymbol: string;
  executionAllowed: boolean;
}

export interface KalshiCandidate {
  id: string;
  ts: string;
  ticker: string;
  series: string;
  underlying: string;
  side: "YES" | "NO";
  ask_price: number;
  fair_yes: number;
  edge: number;
  strike: number;
  close_time: string;
  secs_to_close: number;
  spot: number;
  sigma_annual: number;
  best_yes_bid: number | null;
  best_no_bid: number | null;
  spread: number | null;
  reason: string;
}

export interface KalshiWorkerState {
  startedAt: number;
  lastScanAt: number | null;
  totalScans: number;
  totalShadowFires: number;
  totalCandidates: number;
  candidatesByStatus: Record<string, number>;
  balance: { cash_usd: number; portfolio_value_usd: number } | null;
  spot: number | null;
  sigmaAnnual: number | null;
  exchangeActive: boolean | null;
  lastError: string | null;
  recentCandidates: KalshiCandidate[];
  configuredSeries: KalshiSeriesConfig[];
  allowOrders: boolean;
}

export async function fetchKalshiState(): Promise<KalshiWorkerState | null> {
  try {
    const res = await fetch(`${kalshiWorkerUrl()}/kalshi/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as KalshiWorkerState;
  } catch {
    return null;
  }
}

export async function checkKalshiHealth(): Promise<{ ok: boolean; uptimeSec?: number } | null> {
  try {
    const res = await fetch(`${kalshiWorkerUrl()}/health`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; uptimeSec?: number };
  } catch {
    return null;
  }
}

// ---- dust executor (Phase 2.3a) ----

export type KalshiDustStatus =
  | "pending_confirm"
  | "approved"
  | "submitted"
  | "filled"
  | "canceled"
  | "declined"
  | "expired"
  | "rejected";

export interface KalshiDustCandidate {
  id: string;
  createdAt: number; // unix ms
  expiresAt: number; // unix ms
  status: KalshiDustStatus;
  ticker: string;
  series: string;
  underlying: string;
  side: "YES" | "NO";
  ask_price: number;
  contracts: number;
  notional_usd: number;
  fair_yes: number;
  edge: number;
  strike: number;
  close_time: string;
  spot_at_emit: number;
  sigma_annual: number;
  best_yes_bid: number | null;
  best_no_bid: number | null;
  spread: number | null;
  reason: string;
  resolvedAt?: number;
  orderId?: string | null;
  submitError?: string | null;
}

export interface KalshiDustState {
  candidates: KalshiDustCandidate[];
  tradesSubmittedTotal: number;
  cumulativePnlUsd: number;
  inFlightId: string | null;
  config: {
    enabled: boolean;
    maxNotionalUsd: number;
    maxTradesTotal: number;
    manualConfirmFirstN: number;
    hardStopPnlUsd: number;
    candidateTtlSec: number;
    minOrderSize: number;
  };
}

export async function fetchKalshiDustState(): Promise<KalshiDustState | null> {
  try {
    const res = await fetch(`${kalshiWorkerUrl()}/kalshi/dust/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as KalshiDustState;
  } catch {
    return null;
  }
}

export async function postKalshiDustAction(
  action: "confirm" | "decline" | "submit",
  id: string,
): Promise<{ ok: boolean; reason?: string; result?: unknown }> {
  try {
    const res = await fetch(`${kalshiWorkerUrl()}/kalshi/dust/${action}/${id}`, {
      method: "POST",
    });
    return (await res.json()) as { ok: boolean; reason?: string; result?: unknown };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}
