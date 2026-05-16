"use client";

import * as React from "react";
import type { TerminalSnapshot } from "@polyterminal/types";
import { Card, formatPrice, formatUsd } from "@polyterminal/ui";
import {
  computePreview,
  defaultLimitPrice,
  type Outcome,
  type OrderType,
  type Side,
} from "../lib/orderPreview";
import { useTradingSession } from "../hooks/useTradingSession";
import { useApprovals } from "../hooks/useApprovals";
import { useOrderSubmit } from "../hooks/useOrderSubmit";
import { useFunder } from "../hooks/useFunder";
import { ticketToOrderIntent } from "../lib/ticketToOrder";
import { evaluatePolicy } from "../lib/executionPolicy";
import { SIGNING_SUPPORTED_BY_MODEL, TRADER_MODEL_LABEL } from "../lib/traderModel";
import { collateralForModel } from "../lib/collateralForModel";
import { ApprovalChecklist } from "./ApprovalChecklist";
import { OrderReviewModal } from "./OrderReviewModal";

export function OrderTicket({ snap }: { snap: TerminalSnapshot | null }) {
  const funder = useFunder();
  const collateral = collateralForModel(funder.model);
  const signingSupported = SIGNING_SUPPORTED_BY_MODEL[funder.model];
  const session = useTradingSession({
    funderAddress: funder.funderAddress,
    signatureType: funder.signatureType,
  });
  const submit = useOrderSubmit();
  const primary = snap?.primary ?? null;

  const [side, setSide] = React.useState<Side>("BUY");
  const [outcome, setOutcome] = React.useState<Outcome>("YES");
  const [type, setType] = React.useState<OrderType>("marketable");
  const [sizeStr, setSizeStr] = React.useState<string>("10");
  const [priceStr, setPriceStr] = React.useState<string>("");
  const [reviewOpen, setReviewOpen] = React.useState(false);

  React.useEffect(() => {
    if (type === "limit") return;
    const def = defaultLimitPrice(side, outcome, primary);
    if (def !== null) setPriceStr(def.toFixed(3));
  }, [side, outcome, primary, type]);

  const size = Number(sizeStr);
  const limitPrice = priceStr === "" ? null : Number(priceStr);

  const preview = computePreview({
    side,
    outcome,
    type,
    size,
    limitPrice: type === "limit" ? limitPrice : null,
    primary,
  });

  const cost = side === "BUY" ? preview.notional : null;
  const approvals = useApprovals({
    side,
    cost,
    funder: funder.funderAddress,
    collateral,
  });

  const intent = ticketToOrderIntent({
    side,
    outcome,
    type,
    size,
    executionPrice: preview.executionPrice,
    primary,
  });

  const policy = evaluatePolicy({
    intent,
    primary,
    refPrice: preview.refPrice,
    slippage: preview.slippage,
    approvals: approvals.state,
  });

  const canReview = preview.ok && intent !== null;

  return (
    <Card
      title="order ticket"
      right={
        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
          first-live · max $100
        </span>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-y-auto pr-1 font-mono text-xs">
        <ToggleRow
          options={[
            { label: "BUY", value: "BUY", tone: "buy" },
            { label: "SELL", value: "SELL", tone: "sell" },
          ]}
          value={side}
          onChange={(v) => setSide(v as Side)}
        />
        <ToggleRow
          options={[
            { label: "YES", value: "YES", tone: "buy" },
            { label: "NO", value: "NO", tone: "sell" },
          ]}
          value={outcome}
          onChange={(v) => setOutcome(v as Outcome)}
        />
        <ToggleRow
          options={[
            { label: "MKT", value: "marketable" },
            { label: "LMT", value: "limit" },
          ]}
          value={type}
          onChange={(v) => setType(v as OrderType)}
        />

        <div className="grid grid-cols-2 gap-2">
          <NumInput label="size (shares)" value={sizeStr} onChange={setSizeStr} step="1" />
          <NumInput
            label="price"
            value={priceStr}
            onChange={setPriceStr}
            step="0.001"
            disabled={type === "marketable"}
          />
        </div>

        <div className="mt-1 rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px]">
          <StatLine label="execution px" value={formatPrice(preview.executionPrice ?? null, 3)} />
          <StatLine label="ref (mid)" value={formatPrice(preview.refPrice ?? null, 3)} />
          <StatLine
            label="slippage"
            value={
              preview.slippage === null
                ? "—"
                : `${preview.slippage.toFixed(3)} (${
                    preview.refPrice
                      ? ((preview.slippage / preview.refPrice) * 100).toFixed(2)
                      : "—"
                  }%)`
            }
            tone={
              preview.slippage !== null &&
              preview.refPrice &&
              preview.slippage / preview.refPrice > 0.02
                ? "warn"
                : "default"
            }
          />
          <StatLine label="shares" value={preview.shares.toFixed(2)} />
          <StatLine
            label={side === "BUY" ? "est cost" : "est proceeds"}
            value={preview.notional !== null ? formatUsd(preview.notional) : "—"}
          />
          {!preview.ok && preview.reason && (
            <div className="mt-1 text-[10px] text-rose-300">{preview.reason}</div>
          )}
        </div>

        <ApprovalChecklist
          approvals={approvals.state}
          side={side}
          cost={cost}
          collateralBalance={approvals.collateralBalance}
          collateralAllowance={approvals.collateralAllowance}
          tokenSymbol={collateral.tokenSymbol}
        />

        {!signingSupported && (
          <div className="rounded border border-amber-700 bg-amber-950/30 p-2 text-[10px] font-mono text-amber-200">
            <div className="uppercase tracking-wider">signing unavailable for this model</div>
            <div className="mt-1 text-amber-300/80">
              {TRADER_MODEL_LABEL[funder.model]} requires clob-client-v2 (Phase B). Balance + allowance
              reads still work; submit is gated off.
            </div>
          </div>
        )}

        {signingSupported && (
          <SessionStatus
            state={session.state}
            onPrepare={() => session.ensureSession()}
            onClear={() => session.clear()}
            modelLabel={TRADER_MODEL_LABEL[funder.model]}
          />
        )}

        <button
          type="button"
          disabled={!canReview || !signingSupported}
          onClick={() => setReviewOpen(true)}
          className="mt-1 w-full rounded border border-cyan-700 bg-cyan-950/40 py-2 text-[11px] uppercase tracking-wider text-cyan-200 transition hover:bg-cyan-950 disabled:cursor-not-allowed disabled:opacity-50"
          title={signingSupported ? undefined : "signing path not implemented for this trader model yet"}
        >
          {signingSupported ? "review & sign" : "review (signing disabled)"}
        </button>
      </div>

      <OrderReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        intent={intent}
        primary={primary}
        refPrice={preview.refPrice}
        slippage={preview.slippage}
        policy={policy}
        approvals={approvals.state}
        sessionReady={session.state.status === "ready"}
        onPrepareSession={() => session.ensureSession()}
        submitState={submit.state}
        onResetSubmit={submit.reset}
        onSubmit={async () => {
          if (!intent || session.state.status !== "ready") return;
          await submit.submit(intent, session.state.session);
        }}
      />
    </Card>
  );
}

function ToggleRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ label: string; value: T; tone?: "buy" | "sell" | "default" }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1">
      {options.map((o) => {
        const active = o.value === value;
        const tone =
          o.tone === "buy"
            ? active
              ? "border-emerald-600 bg-emerald-950 text-emerald-200"
              : "border-zinc-800 text-zinc-400 hover:border-emerald-800"
            : o.tone === "sell"
              ? active
                ? "border-rose-600 bg-rose-950 text-rose-200"
                : "border-zinc-800 text-zinc-400 hover:border-rose-800"
              : active
                ? "border-cyan-600 bg-cyan-950 text-cyan-200"
                : "border-zinc-800 text-zinc-400 hover:border-cyan-800";
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wider transition ${tone}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function NumInput({
  label,
  value,
  onChange,
  step,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-700 disabled:opacity-50"
      />
    </label>
  );
}

function StatLine({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={tone === "warn" ? "text-amber-300" : "text-zinc-100"}>{value}</span>
    </div>
  );
}

function SessionStatus({
  state,
  onPrepare,
  onClear,
  modelLabel,
}: {
  state: ReturnType<typeof useTradingSession>["state"];
  onPrepare: () => void;
  onClear: () => void;
  modelLabel: string;
}) {
  const status = state.status;
  const label =
    status === "ready"
      ? "trading session ready"
      : status === "preparing"
        ? "preparing session…"
        : status === "error"
          ? "session error"
          : "trading session not prepared";
  const tone =
    status === "ready"
      ? "border-emerald-700 text-emerald-200"
      : status === "preparing"
        ? "border-cyan-700 text-cyan-200"
        : status === "error"
          ? "border-rose-700 text-rose-200"
          : "border-zinc-700 text-zinc-300";

  return (
    <div className={`rounded border ${tone} bg-zinc-950 p-2 text-[11px]`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono uppercase tracking-wider text-[10px]">{label}</span>
        {status === "ready" ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 hover:border-rose-600 hover:text-rose-300"
            title="clear stored L2 credentials"
          >
            clear
          </button>
        ) : (
          <button
            type="button"
            onClick={onPrepare}
            disabled={status === "preparing"}
            className="rounded border border-cyan-700 bg-cyan-950/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-950 disabled:opacity-50"
          >
            {status === "preparing" ? "signing…" : "prepare"}
          </button>
        )}
      </div>
      {status === "ready" && (
        <div className="mt-1 font-mono text-[10px] text-zinc-500">
          key {state.session.creds.key.slice(0, 8)}… · sig {state.session.signatureType} ·
          funder {state.session.funderAddress.slice(0, 6)}…{state.session.funderAddress.slice(-4)}
        </div>
      )}
      {status === "error" && (
        <div className="mt-1 font-mono text-[10px] text-rose-300">{state.error}</div>
      )}
      {status === "idle" && (
        <div className="mt-1 font-mono text-[10px] text-zinc-500">
          {modelLabel} · one EIP-712 sig · creates/derives L2 API key · sessionStorage
        </div>
      )}
    </div>
  );
}
