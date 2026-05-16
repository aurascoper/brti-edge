"use client";

import * as React from "react";
import type { OutcomeToken, TerminalSnapshot } from "@polyterminal/types";
import { Card, formatPrice, formatUsd } from "@polyterminal/ui";
import { useDustState } from "../hooks/useDustState";
import { useDustSubmit, type DustSubmitState } from "../hooks/useDustSubmit";
import { useTradingSession } from "../hooks/useTradingSession";
import { useFunder } from "../hooks/useFunder";
import { useMarketTokens, type MarketTokenState } from "../hooks/useMarketTokens";
import { SIGNING_SUPPORTED_BY_MODEL } from "../lib/traderModel";
import { postDustAction, type DustCandidate } from "../lib/fetcher";

interface Props {
  snap: TerminalSnapshot | null;
}

const ACTIONABLE_STATUSES = new Set([
  "pending_confirm",
  "approved",
  "dry_run",
]);

function pickTokenIdFromSnap(snap: TerminalSnapshot | null, candidate: DustCandidate): string | null {
  if (!snap) return null;
  const pool = [snap.primary, ...snap.watchlist, ...snap.related].filter(Boolean);
  const market = pool.find((m) => m && m.market.conditionId === candidate.marketId);
  if (!market) return null;
  return pickFromTokens(market.market.tokens, candidate.side);
}

function pickFromTokens(tokens: OutcomeToken[], side: "YES" | "NO"): string | null {
  // Name-based first (handles markets explicitly labeled "Yes"/"No").
  const named = tokens.find((t) =>
    side === "YES" ? /yes|up|true|pass/i.test(t.outcome) : /no|down|false|fail/i.test(t.outcome),
  );
  if (named?.tokenId) return named.tokenId;
  // Positional fallback: Polymarket binary markets consistently order
  // outcome[0] = the strategy's "YES" side. Worker's midpointYes / bestBidYes
  // refer to this token. This handles markets with labels like "Up"/"Down",
  // "Bull"/"Bear", etc.
  const idx = side === "YES" ? 0 : 1;
  return tokens[idx]?.tokenId ?? null;
}

type TokenSource = "snap" | "lazy" | "loading" | "missing";

function resolveTokenId(
  snap: TerminalSnapshot | null,
  lazy: Map<string, MarketTokenState>,
  candidate: DustCandidate,
): { tokenId: string | null; source: TokenSource } {
  const fromSnap = pickTokenIdFromSnap(snap, candidate);
  if (fromSnap) return { tokenId: fromSnap, source: "snap" };
  const state = lazy.get(candidate.marketId);
  if (state?.status === "ready") {
    const id = pickFromTokens(state.tokens, candidate.side);
    if (id) return { tokenId: id, source: "lazy" };
    return { tokenId: null, source: "missing" };
  }
  if (state?.status === "loading") return { tokenId: null, source: "loading" };
  if (state?.status === "missing") return { tokenId: null, source: "missing" };
  // not in cache yet → effect will populate as loading on next tick
  return { tokenId: null, source: "loading" };
}

function notifyCandidate(c: DustCandidate): void {
  if (typeof window === "undefined") return;
  const title = `dust candidate · ${c.side} @ ${c.price.toFixed(3)}`;
  const body =
    `size ${c.size} · notional $${c.notional.toFixed(2)} · edge ${c.edge.toFixed(3)} · ` +
    `5min to sign`;
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body, requireInteraction: true });
      setTimeout(() => n.close(), 60_000);
    } catch {}
  }
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.start();
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.25);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
    osc.stop(ctx.currentTime + 0.45);
  } catch {}
}

function fmtAgeSec(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return `${s}s`;
}

function fmtTtl(expiresAt: number): string {
  const s = Math.round((expiresAt - Date.now()) / 1000);
  if (s <= 0) return "0s";
  return `${s}s`;
}

function statusTone(status: DustCandidate["status"]): string {
  switch (status) {
    case "approved":
      return "border-emerald-700 text-emerald-200 bg-emerald-950/30";
    case "pending_confirm":
      return "border-amber-700 text-amber-200 bg-amber-950/30";
    case "submitted":
      return "border-cyan-700 text-cyan-200 bg-cyan-950/30";
    case "filled":
      return "border-emerald-600 text-emerald-200 bg-emerald-950/40";
    case "rejected":
    case "expired":
    case "declined":
      return "border-zinc-700 text-zinc-500 bg-zinc-950/40";
    case "dry_run":
    default:
      return "border-zinc-700 text-zinc-300 bg-zinc-950/40";
  }
}

export function DustPanel({ snap }: Props) {
  const funder = useFunder();
  const signingSupported = SIGNING_SUPPORTED_BY_MODEL[funder.model];
  const session = useTradingSession({
    funderAddress: funder.funderAddress,
    signatureType: funder.signatureType,
  });
  const dust = useDustState(2_000);
  const submit = useDustSubmit();

  const cfg = dust?.config;
  const live = cfg?.live ?? false;

  const candidates = dust?.candidates ?? [];
  const actionable = candidates.filter((c) => ACTIONABLE_STATUSES.has(c.status));
  const recent = [...candidates].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);

  const missingFromSnap = actionable
    .map((c) => (pickTokenIdFromSnap(snap, c) === null ? c.marketId : null))
    .filter((id): id is string => id !== null);
  const lazyTokens = useMarketTokens(missingFromSnap);

  // Auto-confirm + notify on new pending_confirm candidates (option C).
  // Manual confirm in the UI is replaced by auto-promote-to-approved; the
  // human-in-the-loop remains at the MetaMask sign step.
  const autoConfirmedRef = React.useRef<Set<string>>(new Set());
  const notifiedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        Notification.requestPermission().catch(() => undefined);
      }
    }
  }, []);

  React.useEffect(() => {
    if (!live) return;
    for (const c of actionable) {
      if (c.test === true) continue;
      if (c.status === "pending_confirm" && !autoConfirmedRef.current.has(c.id)) {
        autoConfirmedRef.current.add(c.id);
        void postDustAction("confirm", c.id);
      }
      if (!notifiedRef.current.has(c.id)) {
        notifiedRef.current.add(c.id);
        notifyCandidate(c);
      }
    }
  }, [actionable, live]);

  return (
    <Card
      title="dust executor"
      right={
        <span className="font-mono text-[10px] uppercase tracking-wider">
          <span className={live ? "text-rose-300" : "text-zinc-400"}>
            {live ? "LIVE" : "DRY-RUN"}
          </span>
          {cfg && (
            <span className="ml-2 text-zinc-500">
              {dust!.tradesSubmittedTotal}/{cfg.maxTradesTotal} trades · pnl{" "}
              <span className={dust!.cumulativePnl < 0 ? "text-rose-300" : "text-zinc-300"}>
                {formatUsd(dust!.cumulativePnl)}
              </span>
            </span>
          )}
        </span>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-y-auto pr-1 font-mono text-xs">
        {!dust && (
          <div className="text-zinc-600">worker offline or /dust/state unavailable</div>
        )}

        {cfg && (
          <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-[10px] uppercase tracking-wider text-zinc-500">
            <div>
              strategy={cfg.strategiesAllowed.join(",")} · side={cfg.sidesAllowed.join(",")} ·
              horizon={cfg.horizonsAllowed.join(",")}
            </div>
            <div className="mt-0.5">
              max ${cfg.maxNotionalUsd}/trade · hard stop {formatUsd(cfg.hardStopPnl)} · manual×
              {cfg.manualConfirmFirstN}
            </div>
            <div className="mt-0.5">
              freshness≤{cfg.freshnessMaxSec}s · drift≤{cfg.maxBtcDriftBps}bps · ttl=
              {cfg.candidateTtlSec}s · in_flight={dust!.inFlightId ? "yes" : "no"}
            </div>
          </div>
        )}

        {!signingSupported && (
          <div className="rounded border border-amber-700 bg-amber-950/30 p-2 text-[10px] text-amber-200">
            signing path unsupported for current trader model — view-only
          </div>
        )}

        <SessionBlock state={session.state} onPrepare={() => session.ensureSession()} />

        <SubmitStateBanner state={submit.state} onReset={submit.reset} />

        {actionable.length > 0 && (
          <div className="rounded border-2 border-rose-500 bg-rose-950/40 p-2 text-center font-mono text-[11px] uppercase tracking-wider text-rose-100 animate-pulse">
            ⚠ {actionable.length} actionable candidate{actionable.length > 1 ? "s" : ""} — sign in metamask
          </div>
        )}

        {actionable.length === 0 && (
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3 text-center text-[11px] text-zinc-500">
            no actionable candidates · waiting for shadow fires
          </div>
        )}

        {actionable.map((c) => {
          const resolved = resolveTokenId(snap, lazyTokens, c);
          return (
            <CandidateRow
              key={c.id}
              candidate={c}
              tokenId={resolved.tokenId}
              tokenSource={resolved.source}
              live={live}
              signingSupported={signingSupported}
              sessionReady={session.state.status === "ready"}
              inFlightId={dust!.inFlightId}
              onSign={async () => {
                if (!resolved.tokenId || session.state.status !== "ready") return;
                await submit.submit({
                  candidate: c,
                  tokenId: resolved.tokenId,
                  session: session.state.session,
                });
              }}
            />
          );
        })}

        {recent.length > 0 && (
          <details className="mt-2 rounded border border-zinc-800 bg-zinc-950">
            <summary className="cursor-pointer px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
              recent (last {recent.length})
            </summary>
            <div className="flex flex-col gap-1 px-2 pb-2">
              {recent.map((c) => (
                <div
                  key={c.id}
                  className={`flex items-center justify-between gap-2 rounded border px-1.5 py-0.5 text-[10px] ${statusTone(c.status)}`}
                >
                  <span>{c.marketSlug.slice(0, 32)}</span>
                  <span>
                    {c.side} @ {formatPrice(c.price, 3)} · {c.size} · {c.status}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

function CandidateRow({
  candidate: c,
  tokenId,
  tokenSource,
  live,
  signingSupported,
  sessionReady,
  inFlightId,
  onSign,
}: {
  candidate: DustCandidate;
  tokenId: string | null;
  tokenSource: TokenSource;
  live: boolean;
  signingSupported: boolean;
  sessionReady: boolean;
  inFlightId: string | null;
  onSign: () => void;
}) {
  const [busy, setBusy] = React.useState<"confirming" | "declining" | null>(null);
  const isOther = inFlightId !== null && inFlightId !== c.id;
  const canConfirm = c.status === "pending_confirm" && (live || c.test === true);
  const canSign = live && c.status === "approved" && tokenId !== null && sessionReady && signingSupported && !isOther;

  return (
    <div className={`rounded border ${statusTone(c.status)} p-2`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[11px]">
            {c.test && (
              <span className="rounded border border-fuchsia-700 bg-fuchsia-950/40 px-1 py-0 text-[9px] uppercase tracking-wider text-fuchsia-200">
                test
              </span>
            )}
            <span className="truncate" title={c.marketSlug}>
              {c.marketSlug}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            {c.stamps.strategy} · {c.horizon} · age {fmtAgeSec(c.createdAt)} · ttl {fmtTtl(c.expiresAt)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px]">
            <span className={c.side === "YES" ? "text-emerald-300" : "text-rose-300"}>
              {c.side}
            </span>{" "}
            @ {formatPrice(c.price, 3)}
          </div>
          <div className="text-[10px] text-zinc-500">
            size {c.size} · notional {formatUsd(c.notional)}
          </div>
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-zinc-400">
        <Stamp label="edge" value={c.edge.toFixed(3)} />
        <Stamp label="mid" value={c.stamps.midYes !== null ? c.stamps.midYes.toFixed(3) : "—"} />
        <Stamp
          label="book age"
          value={c.stamps.bookAgeSec !== null ? `${c.stamps.bookAgeSec.toFixed(1)}s` : "—"}
        />
        <Stamp
          label="btc drift"
          value={
            c.stamps.btcDriftBps !== null
              ? `${c.stamps.btcDriftBps >= 0 ? "+" : ""}${c.stamps.btcDriftBps.toFixed(1)}bps`
              : "—"
          }
        />
        <Stamp
          label="σ ann"
          value={c.stamps.sigmaAnnual !== null ? c.stamps.sigmaAnnual.toFixed(2) : "—"}
        />
        <Stamp label="status" value={c.status} />
      </div>

      <div className="mt-1.5 text-[10px] text-zinc-500" title={c.stamps.decisionReason}>
        reason: {c.stamps.decisionReason}
      </div>

      {tokenId === null && tokenSource === "loading" && (
        <div className="mt-1 text-[10px] text-cyan-300">resolving token via gamma…</div>
      )}
      {tokenId === null && tokenSource === "missing" && (
        <div className="mt-1 text-[10px] text-amber-300">
          token not resolvable (snapshot miss + gamma returned no market or wrong tokens)
        </div>
      )}
      {tokenId !== null && tokenSource === "lazy" && (
        <div className="mt-1 text-[10px] text-cyan-300/80">
          token resolved via lazy gamma fetch (not in snapshot)
        </div>
      )}

      {isOther && (
        <div className="mt-1 text-[10px] text-zinc-500">
          another order in flight ({inFlightId?.slice(0, 12)}…) — wait for resolution
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1">
        {canConfirm && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("confirming");
              await postDustAction("confirm", c.id);
              setBusy(null);
            }}
            className="rounded border border-emerald-700 bg-emerald-950/40 px-2 py-1 text-[10px] uppercase tracking-wider text-emerald-200 hover:bg-emerald-950 disabled:opacity-50"
          >
            {busy === "confirming" ? "confirming…" : "confirm"}
          </button>
        )}

        {(c.status === "pending_confirm" || c.status === "approved" || c.status === "dry_run") && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("declining");
              await postDustAction("decline", c.id);
              setBusy(null);
            }}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-300 hover:border-rose-700 hover:text-rose-300 disabled:opacity-50"
          >
            {busy === "declining" ? "declining…" : "decline"}
          </button>
        )}

        {canSign && (
          <button
            type="button"
            onClick={onSign}
            className="rounded border border-cyan-700 bg-cyan-950/40 px-2 py-1 text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-950"
          >
            sign + submit
          </button>
        )}

        {!live && c.status === "dry_run" && (
          <span className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
            dry-run · POLYTERMINAL_DUST_LIVE=1 to arm
          </span>
        )}
      </div>
    </div>
  );
}

function Stamp({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</span>
      <span className="text-zinc-300">{value}</span>
    </div>
  );
}

function SessionBlock({
  state,
  onPrepare,
}: {
  state: ReturnType<typeof useTradingSession>["state"];
  onPrepare: () => void;
}) {
  if (state.status === "ready") {
    return (
      <div className="rounded border border-emerald-700 bg-emerald-950/30 p-2 text-[10px] text-emerald-200">
        signing session ready · key {state.session.creds.key.slice(0, 8)}…
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-zinc-700 bg-zinc-950 p-2 text-[10px]">
      <span className="text-zinc-400">
        {state.status === "preparing"
          ? "preparing session…"
          : state.status === "error"
            ? `session error: ${state.error}`
            : "trading session not prepared"}
      </span>
      <button
        type="button"
        disabled={state.status === "preparing"}
        onClick={onPrepare}
        className="rounded border border-cyan-700 bg-cyan-950/40 px-2 py-0.5 uppercase tracking-wider text-cyan-200 disabled:opacity-50"
      >
        {state.status === "preparing" ? "signing…" : "prepare"}
      </button>
    </div>
  );
}

function SubmitStateBanner({ state, onReset }: { state: DustSubmitState; onReset: () => void }) {
  if (state.status === "idle") return null;
  const tone =
    state.status === "success"
      ? "border-emerald-700 bg-emerald-950/30 text-emerald-200"
      : state.status === "rejected"
        ? "border-rose-700 bg-rose-950/30 text-rose-200"
        : "border-cyan-700 bg-cyan-950/30 text-cyan-200";
  const label =
    state.status === "resolving"
      ? "resolving wallet…"
      : state.status === "signing"
        ? "signing…"
        : state.status === "submitting"
          ? "submitting…"
          : state.status === "success"
            ? `submitted · orderId ${state.result.orderId?.slice(0, 12) ?? "—"}`
            : `rejected · ${state.error}`;
  return (
    <div className={`flex items-center justify-between gap-2 rounded border ${tone} p-2 text-[10px]`}>
      <span>{label}</span>
      {(state.status === "success" || state.status === "rejected") && (
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:border-zinc-500"
        >
          dismiss
        </button>
      )}
    </div>
  );
}
