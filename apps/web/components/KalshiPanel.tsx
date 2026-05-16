"use client";

import * as React from "react";
import { Card, formatUsd } from "@polyterminal/ui";
import { useKalshiState } from "../hooks/useKalshiState";
import { useKalshiDustState } from "../hooks/useKalshiDustState";
import {
  postKalshiDustAction,
  type KalshiCandidate,
  type KalshiDustCandidate,
  type KalshiDustState,
  type KalshiDustStatus,
  type KalshiSeriesConfig,
} from "../lib/kalshiFetcher";

export function KalshiPanel() {
  const state = useKalshiState(2_000);
  const dust = useKalshiDustState(1_500);

  if (!state) {
    return (
      <Card title="kalshi · scanner">
        <div className="flex h-full items-center justify-center text-xs text-zinc-600">
          worker offline · expecting /kalshi/state at :4001
        </div>
      </Card>
    );
  }

  const uptime = Math.round((Date.now() - state.startedAt) / 1000);
  const lastScanSec =
    state.lastScanAt !== null ? Math.round((Date.now() - state.lastScanAt) / 1000) : null;
  const liveCandidates = [...state.recentCandidates].sort(
    (a, b) => b.ts.localeCompare(a.ts),
  );

  const exchangeBadge =
    state.exchangeActive === true ? (
      <span className="text-emerald-300">live</span>
    ) : state.exchangeActive === false ? (
      <span className="text-rose-300">halted</span>
    ) : (
      <span className="text-zinc-500">?</span>
    );

  return (
    <Card
      title="kalshi · scanner"
      right={
        <span className="font-mono text-[10px] uppercase tracking-wider">
          {state.allowOrders ? (
            <span className="rounded border border-rose-600 bg-rose-950/40 px-1 text-rose-200">
              LIVE-ARMED
            </span>
          ) : (
            <span className="text-zinc-400">DRY-RUN</span>
          )}
          <span className="ml-2 text-zinc-500">
            exchange={exchangeBadge} · uptime {fmtDur(uptime)} · last scan{" "}
            {lastScanSec === null ? "—" : `${lastScanSec}s ago`}
          </span>
        </span>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-y-auto pr-1 font-mono text-xs">
        <BalanceRow state={state} />
        <SpotRow state={state} />
        <SeriesGrid configured={state.configuredSeries} />
        <ScannerStats state={state} />
        {state.lastError && (
          <div className="rounded border border-rose-700 bg-rose-950/30 p-1.5 text-[10px] text-rose-200">
            last error: {state.lastError}
          </div>
        )}
        <DustLifecycleSection dust={dust} workerAllowsOrders={state.allowOrders} />
        <CandidateList candidates={liveCandidates} />
      </div>
    </Card>
  );
}

function BalanceRow({ state }: { state: NonNullable<ReturnType<typeof useKalshiState>> }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Tile label="cash" value={state.balance ? formatUsd(state.balance.cash_usd) : "—"} />
      <Tile
        label="portfolio"
        value={state.balance ? formatUsd(state.balance.portfolio_value_usd) : "—"}
      />
    </div>
  );
}

function SpotRow({ state }: { state: NonNullable<ReturnType<typeof useKalshiState>> }) {
  const sigmaPct = state.sigmaAnnual !== null ? (state.sigmaAnnual * 100).toFixed(1) + "%" : "—";
  return (
    <div className="grid grid-cols-2 gap-2">
      <Tile label="btc spot" value={state.spot !== null ? `$${state.spot.toFixed(2)}` : "—"} />
      <Tile label="σ annual" value={sigmaPct} />
    </div>
  );
}

function SeriesGrid({ configured }: { configured: KalshiSeriesConfig[] }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-1.5">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        configured series ({configured.length})
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px]">
        {configured.map((s) => (
          <div
            key={s.series}
            className={`flex items-center justify-between rounded border px-1.5 py-0.5 ${
              s.executionAllowed
                ? "border-emerald-700 bg-emerald-950/30 text-emerald-200"
                : "border-zinc-700 bg-zinc-950 text-zinc-400"
            }`}
            title={`${s.underlying} · cadence ${s.cadenceSec}s · cex ${s.cexSpotSymbol}`}
          >
            <span className="font-mono">{shortSeriesLabel(s.series)}</span>
            <span className="text-[9px]">{s.executionAllowed ? "exec" : "scan"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function shortSeriesLabel(series: string): string {
  // KXBTC15M → BTC; KXETH15M → ETH; etc.
  return series.replace(/^KX/, "").replace(/15M$/, "");
}

function ScannerStats({ state }: { state: NonNullable<ReturnType<typeof useKalshiState>> }) {
  const rate =
    state.totalScans > 0
      ? (state.totalShadowFires / state.totalScans).toFixed(1)
      : "—";
  const hitRate =
    state.totalShadowFires > 0
      ? ((100 * state.totalCandidates) / state.totalShadowFires).toFixed(1) + "%"
      : "—";
  return (
    <div className="grid grid-cols-4 gap-1.5 text-[10px]">
      <Stat label="scans" value={state.totalScans.toString()} />
      <Stat label="shadow" value={state.totalShadowFires.toString()} />
      <Stat label="cand" value={state.totalCandidates.toString()} />
      <Stat label="hit %" value={hitRate} />
      <Stat label="markets/scan" value={rate} colSpan={4} />
    </div>
  );
}

function DustLifecycleSection({
  dust,
  workerAllowsOrders,
}: {
  dust: KalshiDustState | null;
  workerAllowsOrders: boolean;
}) {
  if (!dust) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950 p-1.5 text-[10px] text-zinc-500">
        dust executor offline · /kalshi/dust/state unavailable
      </div>
    );
  }
  const cfg = dust.config;
  const inFlight = dust.candidates.find((c) => c.id === dust.inFlightId);
  const actionable = dust.candidates.filter(
    (c) => c.status === "pending_confirm" || c.status === "approved",
  );
  const recent = [...dust.candidates]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);

  return (
    <div className="flex flex-col gap-1">
      <div className="rounded border border-amber-700/50 bg-amber-950/20 p-1.5 text-[10px]">
        <div className="flex items-center justify-between text-zinc-400">
          <span>
            dust ·{" "}
            <span className="text-amber-300">
              {cfg.enabled ? "armed (dry-run)" : "disabled"}
            </span>
          </span>
          <span>
            {dust.tradesSubmittedTotal}/{cfg.maxTradesTotal} trades · pnl{" "}
            <span className={dust.cumulativePnlUsd < 0 ? "text-rose-300" : "text-zinc-300"}>
              {formatUsd(dust.cumulativePnlUsd)}
            </span>
          </span>
        </div>
        <div className="mt-0.5 grid grid-cols-3 gap-x-2 gap-y-0 text-[9px] text-zinc-500">
          <Stamp label="max $" value={cfg.maxNotionalUsd.toString()} />
          <Stamp label="ttl" value={`${cfg.candidateTtlSec}s`} />
          <Stamp label="stop $" value={cfg.hardStopPnlUsd.toString()} />
          <Stamp label="manual×" value={cfg.manualConfirmFirstN.toString()} />
          <Stamp label="min sz" value={cfg.minOrderSize.toString()} />
          <Stamp label="in flight" value={inFlight ? "yes" : "no"} />
        </div>
      </div>

      {actionable.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-950 p-1.5 text-center text-[10px] text-zinc-500">
          no actionable dust candidates · waiting for scanner to qualify one
        </div>
      ) : (
        <>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
            actionable ({actionable.length})
          </div>
          {actionable.map((c) => (
            <DustCandidateRow
              key={c.id}
              c={c}
              workerAllowsOrders={workerAllowsOrders}
              tradesRemaining={dust.config.maxTradesTotal - dust.tradesSubmittedTotal}
            />
          ))}
        </>
      )}

      {recent.length > 0 && (
        <details className="rounded border border-zinc-800 bg-zinc-950">
          <summary className="cursor-pointer px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
            recent dust ({recent.length})
          </summary>
          <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
            {recent.map((c) => (
              <div
                key={c.id}
                className={`flex items-center justify-between gap-2 rounded border px-1 py-0.5 text-[9px] ${dustStatusTone(c.status)}`}
              >
                <span className="truncate">
                  {c.ticker} {c.side} @{c.ask_price.toFixed(3)}
                </span>
                <span>{c.status}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function DustCandidateRow({
  c,
  workerAllowsOrders,
  tradesRemaining,
}: {
  c: KalshiDustCandidate;
  workerAllowsOrders: boolean;
  tradesRemaining: number;
}) {
  const [busy, setBusy] = React.useState<"confirming" | "declining" | "submitting" | null>(null);
  const [submitMsg, setSubmitMsg] = React.useState<string | null>(null);
  const ttlSec = Math.max(0, Math.round((c.expiresAt - Date.now()) / 1000));
  const isPending = c.status === "pending_confirm";
  const isApproved = c.status === "approved";

  async function act(kind: "confirm" | "decline" | "submit") {
    setBusy(kind === "confirm" ? "confirming" : kind === "decline" ? "declining" : "submitting");
    setSubmitMsg(null);
    const r = await postKalshiDustAction(kind, c.id);
    if (kind === "submit") setSubmitMsg(r.ok ? "submitted ✓" : `failed: ${r.reason ?? "unknown"}`);
    setBusy(null);
  }

  const canSubmit =
    isApproved &&
    workerAllowsOrders &&
    ttlSec > 0 &&
    tradesRemaining > 0 &&
    !c.orderId; // not already submitted

  return (
    <div className={`rounded border p-1.5 ${dustStatusTone(c.status)}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1 truncate">
          <span className="rounded border border-current px-1 text-[9px] uppercase tracking-wider">
            {c.status === "pending_confirm" ? "pending" : c.status}
          </span>
          <span className={`font-mono font-semibold ${c.side === "YES" ? "text-emerald-300" : "text-rose-300"}`}>
            {c.side}
          </span>
          <span className="text-zinc-400">@</span>
          <span className="font-mono">{c.ask_price.toFixed(3)}</span>
          <span className="text-zinc-500">·</span>
          <span className="truncate text-zinc-400">{c.ticker}</span>
        </div>
        <span className="text-zinc-500 text-[9px]">
          ttl {ttlSec}s
        </span>
      </div>
      <div className="mt-0.5 grid grid-cols-4 gap-x-2 gap-y-0 text-[9px] text-zinc-400">
        <Stamp label="size" value={c.contracts.toString()} />
        <Stamp label="notional" value={`$${c.notional_usd.toFixed(2)}`} />
        <Stamp label="edge" value={c.edge.toFixed(3)} />
        <Stamp label="fair" value={c.fair_yes.toFixed(3)} />
        <Stamp label="strike" value={`$${c.strike.toFixed(0)}`} />
        <Stamp label="spot@" value={`$${c.spot_at_emit.toFixed(0)}`} />
        <Stamp label="σ" value={c.sigma_annual.toFixed(3)} />
        <Stamp label="spread" value={c.spread !== null ? c.spread.toFixed(3) : "—"} />
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {isPending && (
          <button
            type="button"
            disabled={busy !== null || ttlSec <= 0}
            onClick={() => void act("confirm")}
            className="rounded border border-emerald-700 bg-emerald-950/40 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-200 hover:bg-emerald-950 disabled:opacity-50"
          >
            {busy === "confirming" ? "confirming…" : "confirm"}
          </button>
        )}
        {(isPending || isApproved) && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("decline")}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[9px] uppercase tracking-wider text-zinc-300 hover:border-rose-700 hover:text-rose-300 disabled:opacity-50"
          >
            {busy === "declining" ? "declining…" : "decline"}
          </button>
        )}
        {canSubmit && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("submit")}
            className="rounded border border-rose-600 bg-rose-950/40 px-2 py-0.5 text-[9px] uppercase tracking-wider text-rose-200 hover:bg-rose-950 disabled:opacity-50"
            title={`Submit $${c.notional_usd.toFixed(2)} limit ${c.side} @ ${c.ask_price.toFixed(3)} on ${c.ticker}`}
          >
            {busy === "submitting" ? "submitting…" : `submit $${c.notional_usd.toFixed(2)} limit`}
          </button>
        )}
        {isApproved && !workerAllowsOrders && (
          <span className="rounded border border-amber-700 bg-amber-950 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-200">
            approved · worker kill switch ON (KALSHI_ALLOW_ORDERS=0)
          </span>
        )}
        {isApproved && workerAllowsOrders && tradesRemaining <= 0 && (
          <span className="rounded border border-amber-700 bg-amber-950 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-200">
            max trades reached
          </span>
        )}
      </div>
      {c.orderId && (
        <div className="mt-1 text-[9px] text-emerald-300">orderId: {c.orderId}</div>
      )}
      {c.submitError && (
        <div className="mt-1 text-[9px] text-rose-300">submit error: {c.submitError}</div>
      )}
      {submitMsg && (
        <div className="mt-1 text-[9px] text-zinc-400">{submitMsg}</div>
      )}
    </div>
  );
}

function dustStatusTone(status: KalshiDustStatus): string {
  switch (status) {
    case "pending_confirm":
      return "border-amber-700 bg-amber-950/30 text-amber-200";
    case "approved":
      return "border-emerald-700 bg-emerald-950/30 text-emerald-200";
    case "declined":
      return "border-zinc-700 bg-zinc-950 text-zinc-500";
    case "expired":
      return "border-zinc-700 bg-zinc-950/40 text-zinc-500";
    default:
      return "border-zinc-700 bg-zinc-950 text-zinc-300";
  }
}

function CandidateList({ candidates }: { candidates: KalshiCandidate[] }) {
  if (candidates.length === 0) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-center text-[11px] text-zinc-500">
        no candidates yet · scanner is alive but model finds no edge
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">
        recent candidates · newest first ({candidates.length})
      </div>
      {candidates.map((c) => (
        <CandidateRow key={c.id} c={c} />
      ))}
    </div>
  );
}

function CandidateRow({ c }: { c: KalshiCandidate }) {
  const sideColor = c.side === "YES" ? "text-emerald-300" : "text-rose-300";
  const exec = c.series === "KXBTC15M";
  return (
    <div
      className={`rounded border p-1.5 text-[10px] ${
        exec ? "border-amber-700 bg-amber-950/20" : "border-zinc-800 bg-zinc-950"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1 truncate">
          {exec && (
            <span className="rounded border border-amber-600 bg-amber-950 px-1 text-[9px] uppercase tracking-wider text-amber-200">
              exec
            </span>
          )}
          <span className={`font-mono font-semibold ${sideColor}`}>{c.side}</span>
          <span className="text-zinc-400">@</span>
          <span className="font-mono">{c.ask_price.toFixed(3)}</span>
          <span className="text-zinc-500">·</span>
          <span className="truncate text-zinc-400">{c.ticker}</span>
        </div>
        <span className="text-zinc-500">{fmtTimeAgo(c.ts)}</span>
      </div>
      <div className="mt-0.5 grid grid-cols-4 gap-x-2 gap-y-0 text-[9px] text-zinc-400">
        <Stamp label="edge" value={c.edge.toFixed(3)} />
        <Stamp label="fair" value={c.fair_yes.toFixed(3)} />
        <Stamp label="strike" value={`$${c.strike.toFixed(0)}`} />
        <Stamp label="spot" value={`$${c.spot.toFixed(0)}`} />
        <Stamp label="σ" value={c.sigma_annual.toFixed(3)} />
        <Stamp label="spread" value={c.spread !== null ? c.spread.toFixed(3) : "—"} />
        <Stamp
          label="bid Y"
          value={c.best_yes_bid !== null ? c.best_yes_bid.toFixed(3) : "—"}
        />
        <Stamp
          label="bid N"
          value={c.best_no_bid !== null ? c.best_no_bid.toFixed(3) : "—"}
        />
      </div>
      <div className="mt-0.5 text-[9px] text-zinc-600">
        closes {fmtClose(c.secs_to_close)} · {c.reason.slice(0, 90)}
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="font-mono text-sm text-zinc-100">{value}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  colSpan,
}: {
  label: string;
  value: React.ReactNode;
  colSpan?: number;
}) {
  return (
    <div
      className={`rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 ${colSpan ? `col-span-${colSpan}` : ""}`}
    >
      <span className="text-[9px] uppercase tracking-wider text-zinc-500">{label} </span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

function Stamp({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="uppercase tracking-wider text-zinc-600">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function fmtTimeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function fmtClose(secs: number): string {
  if (secs <= 0) return "settled";
  if (secs < 60) return `${Math.round(secs)}s`;
  return `${Math.round(secs / 60)}m`;
}

function fmtDur(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}
