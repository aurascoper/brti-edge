import type { TerminalSnapshot } from "@polyterminal/types";

export function workerUrl(): string {
  return process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:4000";
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
  status:
    | "pending_confirm"
    | "approved"
    | "submitted"
    | "filled"
    | "rejected"
    | "expired"
    | "declined"
    | "dry_run";
  policyDecision: {
    approved: boolean;
    reasons: string[];
    cappedSize: number;
    requiresManualConfirm: boolean;
  };
  stamps: {
    strategy: string;
    bookAgeSec: number | null;
    btcDriftBps: number | null;
    sigmaAnnual: number | null;
    midYes: number | null;
    decisionReason: string;
  };
  test?: boolean;
  signedOrderId?: string | null;
  realizedPnl?: number | null;
}

export interface DustStateResponse {
  candidates: DustCandidate[];
  tradesSubmittedTotal: number;
  cumulativePnl: number;
  inFlightId: string | null;
  config: {
    enabled: boolean;
    live: boolean;
    strategiesAllowed: string[];
    sidesAllowed: string[];
    horizonsAllowed: string[];
    maxNotionalUsd: number;
    maxTradesTotal: number;
    manualConfirmFirstN: number;
    hardStopPnl: number;
    maxBtcDriftBps: number;
    freshnessMaxSec: number;
    candidateTtlSec: number;
  };
}

export async function fetchDustState(): Promise<DustStateResponse | null> {
  try {
    const res = await fetch(`${workerUrl()}/dust/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as DustStateResponse;
  } catch {
    return null;
  }
}

export async function postDustAction(
  path: "confirm" | "decline",
  id: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${workerUrl()}/dust/${path}/${id}`, { method: "POST" });
    return (await res.json()) as { ok: boolean; reason?: string };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

export async function postDustSubmitted(
  id: string,
  signedOrderId: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${workerUrl()}/dust/submitted/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedOrderId }),
    });
    return (await res.json()) as { ok: boolean; reason?: string };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

export async function fetchSnapshot(): Promise<TerminalSnapshot | null> {
  try {
    const res = await fetch(`${workerUrl()}/snapshot`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TerminalSnapshot;
  } catch {
    return null;
  }
}

export async function setPrimary(conditionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl()}/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conditionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearPrimary(): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl()}/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auto: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
