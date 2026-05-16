import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRow } from "../strategy/types";
import { evaluate, loadPolicyFromEnv } from "./dustPolicy";
import type {
  DustCandidate,
  DustCandidateStatus,
  DustPolicyConfig,
  DustState,
} from "./types";

const TARGET_STRATEGY = "fairValueArb";

export class DustExecutor {
  private state: DustState;
  private config: DustPolicyConfig;

  constructor(
    private readonly stateFile: string,
    private readonly candidatesLog: string,
  ) {
    mkdirSync(dirname(stateFile), { recursive: true });
    this.config = loadPolicyFromEnv();
    this.state = this.loadState();
    this.logBoot();
  }

  private logBoot(): void {
    const testInject =
      process.env.POLYTERMINAL_DUST_TEST_INJECT === "1" && !this.config.live;
    console.log(
      `[dust] enabled=${this.config.enabled} live=${this.config.live} ` +
        `sides=${this.config.sidesAllowed.join(",")} ` +
        `horizons=${this.config.horizonsAllowed.join(",")} ` +
        `max_notional=$${this.config.maxNotionalUsd} ` +
        `max_trades=${this.config.maxTradesTotal} ` +
        `pnl_stop=$${this.config.hardStopPnl} ` +
        `test_inject=${testInject ? "armed" : "off"} ` +
        `submitted_so_far=${this.state.tradesSubmittedTotal} ` +
        `cum_pnl=$${this.state.cumulativePnl.toFixed(2)}`,
    );
  }

  private loadState(): DustState {
    if (!existsSync(this.stateFile)) {
      return { candidates: [], tradesSubmittedTotal: 0, cumulativePnl: 0, inFlightId: null };
    }
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      return JSON.parse(raw) as DustState;
    } catch {
      return { candidates: [], tradesSubmittedTotal: 0, cumulativePnl: 0, inFlightId: null };
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn("[dust] saveState failed", err);
    }
  }

  private appendCandidateLog(c: DustCandidate): void {
    try {
      const fs = require("node:fs");
      fs.appendFileSync(this.candidatesLog, JSON.stringify(c) + "\n");
    } catch {}
  }

  evaluate(row: DecisionRow): DustCandidate | null {
    const d = row.decisions[TARGET_STRATEGY];
    if (!d || d.side === "SKIP" || d.price === null) return null;

    const policyDecision = evaluate({
      strategyName: TARGET_STRATEGY,
      row,
      config: this.config,
      state: this.state,
    });

    if (!policyDecision.approved) {
      console.log(
        `[dust] candidate REJECTED ${row.marketSlug.slice(0, 36)} ${d.side} @${d.price.toFixed(3)} reasons=${policyDecision.reasons.join(",")}`,
      );
      return null;
    }

    const horizon = row.marketSlug.includes("btc-updown-5m")
      ? "5m"
      : row.marketSlug.includes("btc-updown-15m")
        ? "15m"
        : "other";

    const btcDriftBps =
      row.sRef && row.sCurrent && row.sRef > 0 && row.sCurrent > 0
        ? Math.log(row.sCurrent / row.sRef) * 10_000
        : null;

    const candidate: DustCandidate = {
      id: makeId(),
      createdAt: Date.now(),
      marketId: row.marketId,
      marketSlug: row.marketSlug,
      horizon,
      side: d.side as "YES" | "NO",
      price: d.price,
      size: policyDecision.cappedSize,
      notional: d.price * policyDecision.cappedSize,
      edge: extractEdge(d.reason),
      expiresAt: Date.now() + this.config.candidateTtlSec * 1000,
      status: !this.config.live
        ? "dry_run"
        : policyDecision.requiresManualConfirm
          ? "pending_confirm"
          : "approved",
      policyDecision,
      stamps: {
        strategy: TARGET_STRATEGY,
        bookAgeSec: row.bookAgeSec,
        btcDriftBps,
        sigmaAnnual: row.sigmaAnnual,
        midYes: row.midYes,
        decisionReason: d.reason,
      },
    };

    this.state.candidates.push(candidate);
    if (candidate.status === "approved") this.state.inFlightId = candidate.id;
    this.saveState();
    this.appendCandidateLog(candidate);

    console.log(
      `[dust] CANDIDATE ${candidate.status} ${candidate.marketSlug.slice(0, 36)} ${candidate.side} @${candidate.price.toFixed(3)} sz=${candidate.size} notional=$${candidate.notional.toFixed(2)} edge=${candidate.edge.toFixed(3)} ${candidate.status === "pending_confirm" ? `confirm_via=POST /dust/confirm/${candidate.id}` : ""}`,
    );

    return candidate;
  }

  confirm(id: string): { ok: boolean; reason?: string } {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    if (!this.config.live && !c.test) return { ok: false, reason: "live_mode_off" };
    if (c.status !== "pending_confirm") return { ok: false, reason: `status=${c.status}` };
    if (Date.now() > c.expiresAt) {
      c.status = "expired";
      this.saveState();
      return { ok: false, reason: "expired" };
    }
    c.status = "approved";
    this.state.inFlightId = c.id;
    this.saveState();
    return { ok: true };
  }

  decline(id: string): { ok: boolean; reason?: string } {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    if (
      c.status === "pending_confirm" ||
      c.status === "approved" ||
      c.status === "dry_run"
    ) {
      c.status = "declined";
      if (this.state.inFlightId === c.id) this.state.inFlightId = null;
      this.saveState();
      return { ok: true };
    }
    return { ok: false, reason: `status=${c.status}` };
  }

  recordSubmission(id: string, signedOrderId: string | null): { ok: boolean; reason?: string } {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    if (c.status !== "approved") return { ok: false, reason: `status=${c.status}` };
    c.status = "submitted";
    c.signedOrderId = signedOrderId;
    if (!c.test) this.state.tradesSubmittedTotal += 1;
    this.saveState();
    return { ok: true };
  }

  recordResolution(id: string, realizedPnl: number, filled: boolean): { ok: boolean; reason?: string } {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) return { ok: false, reason: "candidate_not_found" };
    c.realizedPnl = realizedPnl;
    c.status = filled ? "filled" : "rejected";
    if (!c.test) this.state.cumulativePnl += realizedPnl;
    if (this.state.inFlightId === c.id) this.state.inFlightId = null;
    this.saveState();
    return { ok: true };
  }

  injectTest(overrides: {
    marketId?: string;
    marketSlug?: string;
    side?: "YES" | "NO";
    price?: number;
    size?: number;
    horizon?: "5m" | "15m" | "other";
    ttlSec?: number;
    status?: DustCandidateStatus;
  } = {}): { ok: boolean; candidate?: DustCandidate; reason?: string } {
    if (process.env.POLYTERMINAL_DUST_TEST_INJECT !== "1") {
      return { ok: false, reason: "test_inject_disabled" };
    }
    if (this.config.live) {
      return { ok: false, reason: "test_inject_hard_blocked_in_live_mode" };
    }
    const now = Date.now();
    const side = overrides.side ?? "NO";
    const price = overrides.price ?? 0.5;
    const size = overrides.size ?? Math.floor((this.config.maxNotionalUsd / price) * 100) / 100;
    const horizon = overrides.horizon ?? "5m";
    const ttlSec = overrides.ttlSec ?? this.config.candidateTtlSec;
    const defaultStatus: DustCandidateStatus = !this.config.live ? "dry_run" : "pending_confirm";
    const status = overrides.status ?? defaultStatus;
    const candidate: DustCandidate = {
      id: `dust-test-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      marketId: overrides.marketId ?? "0xTEST",
      marketSlug: overrides.marketSlug ?? `btc-updown-${horizon}-TEST-${Math.floor(now / 1000)}`,
      horizon,
      side,
      price,
      size,
      notional: price * size,
      edge: 0,
      expiresAt: now + ttlSec * 1000,
      status,
      policyDecision: {
        approved: true,
        reasons: ["test_inject"],
        cappedSize: size,
        requiresManualConfirm: status === "pending_confirm",
      },
      stamps: {
        strategy: TARGET_STRATEGY,
        bookAgeSec: 0,
        btcDriftBps: 0,
        sigmaAnnual: null,
        midYes: price,
        decisionReason: "test_inject",
      },
      test: true,
    };
    this.state.candidates.push(candidate);
    this.saveState();
    this.appendCandidateLog(candidate);
    console.log(
      `[dust] TEST_INJECT ${candidate.id} ${candidate.side} @${candidate.price.toFixed(3)} sz=${candidate.size} status=${status} ttl=${ttlSec}s`,
    );
    return { ok: true, candidate };
  }

  expireStale(): void {
    const now = Date.now();
    let changed = false;
    for (const c of this.state.candidates) {
      if (
        (c.status === "pending_confirm" ||
          c.status === "dry_run" ||
          c.status === "approved") &&
        now > c.expiresAt
      ) {
        c.status = "expired";
        if (this.state.inFlightId === c.id) this.state.inFlightId = null;
        changed = true;
      }
    }
    if (changed) this.saveState();
  }

  getState(): DustState & { config: DustPolicyConfig } {
    return { ...this.state, config: this.config };
  }
}

function extractEdge(reason: string): number {
  for (const tag of ["edge=", "noEdge="] as const) {
    if (reason.includes(tag)) {
      try {
        return Number(reason.split(tag)[1]!.split("_")[0]);
      } catch {}
    }
  }
  return 0;
}

function makeId(): string {
  return `dust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
