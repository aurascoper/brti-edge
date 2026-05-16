"use client";

import * as React from "react";
import type { MarketSnapshot } from "@polyterminal/types";
import type { OrderIntent } from "@polyterminal/polymarket-client";
import { formatPrice, formatUsd } from "@polyterminal/ui";
import type { PolicyResult } from "../lib/executionPolicy";
import type { ApprovalState } from "../lib/approvalState";
import type { SubmitState } from "../hooks/useOrderSubmit";

export interface OrderReviewModalProps {
  open: boolean;
  onClose: () => void;
  intent: OrderIntent | null;
  primary: MarketSnapshot | null;
  refPrice: number | null;
  slippage: number | null;
  policy: PolicyResult;
  approvals: ApprovalState;
  sessionReady: boolean;
  onPrepareSession: () => Promise<unknown> | unknown;
  submitState: SubmitState;
  onSubmit: () => Promise<unknown> | unknown;
  onResetSubmit: () => void;
}

const CONFIRM_WORD = "CONFIRM";

export function OrderReviewModal({
  open,
  onClose,
  intent,
  primary,
  refPrice,
  slippage,
  policy,
  approvals,
  sessionReady,
  onPrepareSession,
  submitState,
  onSubmit,
  onResetSubmit,
}: OrderReviewModalProps) {
  const [confirmText, setConfirmText] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setConfirmText("");
      if (submitState.status === "success" || submitState.status === "rejected") onResetSubmit();
    }
  }, [open, submitState.status, onResetSubmit]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !intent) return null;

  const notional = intent.price * intent.size;
  const slipPct = slippage !== null && refPrice ? (slippage / refPrice) * 100 : null;
  const approvalsClear =
    approvals.status === "ready" ||
    (intent.side === "SELL" && approvals.status === "approval-required");
  const confirmed = confirmText === CONFIRM_WORD;
  const inFlight = submitState.status === "signing" || submitState.status === "submitting";
  const canSubmit =
    policy.ok && approvalsClear && sessionReady && confirmed && !inFlight;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-950 p-4 font-mono shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between border-b border-zinc-800 pb-2">
          <span className="text-xs uppercase tracking-wider text-zinc-400">review order</span>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-200"
          >
            esc · close
          </button>
        </header>

        <div className="mb-3 rounded border border-amber-700 bg-amber-950/40 px-2 py-1.5 text-[10px] uppercase tracking-wider text-amber-200">
          first-live mode · max $100 notional · signs real orders on polygon
        </div>

        <div className="mb-3 text-[11px] leading-tight text-zinc-200" title={primary?.market.question}>
          {primary?.market.question ?? "—"}
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
          <Field label="side" value={intent.side} tone={intent.side === "BUY" ? "buy" : "sell"} />
          <Field
            label="outcome"
            value={intent.outcome}
            tone={intent.outcome === "YES" ? "buy" : "sell"}
          />
          <Field label="type" value={intent.orderType} />
          <Field label="size" value={intent.size.toFixed(2)} />
          <Field label="price" value={formatPrice(intent.price, 4)} />
          <Field
            label={intent.side === "BUY" ? "est cost" : "est proceeds"}
            value={formatUsd(notional)}
          />
          <Field label="ref mid" value={formatPrice(refPrice, 4)} />
          <Field
            label="slippage"
            value={slipPct === null ? "—" : `${slipPct.toFixed(2)}%`}
            tone={slipPct !== null && slipPct > 2 ? "warn" : "default"}
          />
        </div>

        {policy.violations.length > 0 && (
          <div className="mb-3 rounded border border-rose-800 bg-rose-950/40 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-rose-300">
              policy violations
            </div>
            {policy.violations.map((v) => (
              <div key={v} className="text-rose-200">
                ✗ {v}
              </div>
            ))}
          </div>
        )}

        {!sessionReady && policy.ok && (
          <div className="mb-3 rounded border border-cyan-800 bg-cyan-950/40 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-cyan-300">
              trading session required
            </div>
            <button
              type="button"
              onClick={() => onPrepareSession()}
              className="mt-1 rounded border border-cyan-700 bg-cyan-950 px-2 py-1 text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-900"
            >
              prepare session
            </button>
          </div>
        )}

        {!approvalsClear && policy.ok && (
          <div className="mb-3 rounded border border-amber-800 bg-amber-950/40 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-300">
              approvals not ready
            </div>
            {approvals.blockingReasons.map((r) => (
              <div key={r} className="text-amber-200">
                ✗ {r}
              </div>
            ))}
            {approvals.approvalReasons.map((r) => (
              <div key={r} className="text-amber-200">
                · {r}
              </div>
            ))}
          </div>
        )}

        {submitState.status === "success" && (
          <div className="mb-3 rounded border border-emerald-800 bg-emerald-950/40 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-300">
              submitted
            </div>
            <div className="font-mono text-[10px] text-emerald-200">
              orderId: {submitState.result.orderId ?? "—"}
            </div>
            <div className="font-mono text-[10px] text-emerald-200">
              status: {submitState.result.status ?? "—"}
            </div>
          </div>
        )}

        {submitState.status === "rejected" && (
          <div className="mb-3 rounded border border-rose-800 bg-rose-950/40 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-rose-300">
              rejected
            </div>
            <div className="font-mono text-[10px] text-rose-200">{submitState.error}</div>
          </div>
        )}

        {policy.ok && approvalsClear && sessionReady && submitState.status === "idle" && (
          <div className="mb-3 rounded border border-zinc-700 bg-zinc-900 p-2 text-[11px]">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                type CONFIRM to enable submit
              </span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CONFIRM"
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs uppercase tracking-wider text-zinc-100 outline-none focus:border-emerald-700"
              />
            </label>
          </div>
        )}

        <div className="rounded border border-zinc-800 bg-zinc-900 p-2 text-[10px] text-zinc-400">
          this is the boundary before money moves. submit signs your order and posts it to the
          polymarket CLOB.
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={inFlight}
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 py-2 text-xs uppercase tracking-wider text-zinc-300 hover:border-zinc-600 disabled:opacity-50"
          >
            cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit()}
            className="flex-1 rounded border border-emerald-700 bg-emerald-950/60 py-2 text-xs uppercase tracking-wider text-emerald-200 transition hover:bg-emerald-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
          >
            {submitState.status === "signing"
              ? "awaiting signature…"
              : submitState.status === "submitting"
                ? "submitting…"
                : submitState.status === "success"
                  ? "submitted ✓"
                  : "sign & submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "buy" | "sell" | "warn";
}) {
  const cls =
    tone === "buy"
      ? "text-emerald-300"
      : tone === "sell"
        ? "text-rose-300"
        : tone === "warn"
          ? "text-amber-300"
          : "text-zinc-100";
  return (
    <div className="flex flex-col gap-0.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1">
      <span className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-xs ${cls}`}>{value}</span>
    </div>
  );
}
