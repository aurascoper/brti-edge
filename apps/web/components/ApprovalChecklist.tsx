"use client";

import { formatUsd } from "@polyterminal/ui";
import type { ApprovalState } from "../lib/approvalState";

export function ApprovalChecklist({
  approvals,
  side,
  cost,
  collateralBalance,
  collateralAllowance,
  tokenSymbol = "USDC.e",
}: {
  approvals: ApprovalState;
  side: "BUY" | "SELL";
  cost: number | null;
  collateralBalance: number | null;
  collateralAllowance: number | null;
  tokenSymbol?: string;
}) {
  const { details, status } = approvals;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">approvals</span>
        <StatusPill status={status} />
      </div>
      <Check label="wallet connected" ok={details.walletConnected} />
      <Check label="polygon network" ok={details.onPolygon} />
      <Check
        label={`${tokenSymbol} balance`}
        ok={details.balanceOk}
        detail={
          collateralBalance === null
            ? "—"
            : cost === null
              ? formatUsd(collateralBalance)
              : `${formatUsd(collateralBalance)} / need ${formatUsd(cost)}`
        }
        irrelevant={side === "SELL"}
      />
      <Check
        label={`${tokenSymbol} allowance → exchange`}
        ok={details.allowanceOk}
        detail={
          collateralAllowance === null
            ? "—"
            : cost === null
              ? formatUsd(collateralAllowance)
              : `${formatUsd(collateralAllowance)} / need ${formatUsd(cost)}`
        }
        irrelevant={side === "SELL"}
      />
      <Check
        label="CTF outcome token approval"
        ok={null}
        detail="needed on first SELL"
        irrelevant={side === "BUY"}
      />
    </div>
  );
}

function StatusPill({ status }: { status: ApprovalState["status"] }) {
  const map = {
    ready: { label: "ready", tone: "border-emerald-700 text-emerald-300" },
    blocked: { label: "blocked", tone: "border-rose-700 text-rose-300" },
    "approval-required": { label: "approval required", tone: "border-amber-700 text-amber-300" },
    unknown: { label: "unknown", tone: "border-zinc-700 text-zinc-400" },
  } as const;
  const s = map[status];
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${s.tone}`}
    >
      {s.label}
    </span>
  );
}

function Check({
  label,
  ok,
  detail,
  irrelevant,
}: {
  label: string;
  ok: boolean | null;
  detail?: string;
  irrelevant?: boolean;
}) {
  if (irrelevant) {
    return (
      <div className="flex items-center justify-between gap-2 text-zinc-600">
        <span>
          <span className="mr-1">·</span>
          {label}
        </span>
        <span className="text-[10px]">{detail ?? "n/a"}</span>
      </div>
    );
  }
  const dot =
    ok === true ? "text-emerald-400" : ok === false ? "text-rose-400" : "text-zinc-500";
  const glyph = ok === true ? "✓" : ok === false ? "✗" : "·";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={dot}>
        <span className="mr-1">{glyph}</span>
        {label}
      </span>
      {detail && <span className="text-[10px] text-zinc-500">{detail}</span>}
    </div>
  );
}
