"use client";

import * as React from "react";
import {
  isHexAddress,
  TRADER_MODEL_HINT,
  TRADER_MODEL_LABEL,
  type TraderModel,
} from "../lib/traderModel";
import { useFunder } from "../hooks/useFunder";

export function FunderSetup({ funder }: { funder: ReturnType<typeof useFunder> }) {
  const [open, setOpen] = React.useState(false);
  const [pendingModel, setPendingModel] = React.useState<TraderModel>(funder.model);
  const [pendingAddress, setPendingAddress] = React.useState<string>(
    funder.funderAddress ?? "",
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPendingModel(funder.model);
    setPendingAddress(funder.funderAddress ?? "");
  }, [funder.model, funder.funderAddress]);

  if (!funder.eoa) return null;

  const isEOA = pendingModel === "EOA";
  const targetForModel = isEOA ? funder.eoa : pendingAddress.trim();
  const apply = () => {
    const target = isEOA ? funder.eoa! : pendingAddress.trim();
    if (!isHexAddress(target)) {
      setError("invalid address");
      return;
    }
    const ok = funder.setFunder(target, pendingModel);
    if (!ok) {
      setError("save failed");
      return;
    }
    setError(null);
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px]">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              trader model
            </span>
            <span className="font-mono text-zinc-200">{TRADER_MODEL_LABEL[funder.model]}</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300 hover:border-cyan-600 hover:text-cyan-200"
          >
            change
          </button>
        </div>
        <div className="mt-1 font-mono text-[10px] text-zinc-500">
          funder {funder.funderAddress?.slice(0, 6)}…{funder.funderAddress?.slice(-4)}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded border border-cyan-800 bg-cyan-950/30 p-2 text-[11px]">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-cyan-300">
        configure trader model
      </div>
      <div className="flex flex-col gap-1">
        {(["POLY_1271", "POLY_GNOSIS_SAFE", "POLY_PROXY", "EOA"] as TraderModel[]).map((m) => (
          <label key={m} className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="trader-model"
              checked={pendingModel === m}
              onChange={() => setPendingModel(m)}
              className="mt-1 accent-cyan-500"
            />
            <span className="flex flex-col">
              <span className="font-mono text-[11px] text-zinc-100">
                {TRADER_MODEL_LABEL[m]}
              </span>
              <span className="font-mono text-[10px] text-zinc-500">
                {TRADER_MODEL_HINT[m]}
              </span>
            </span>
          </label>
        ))}
      </div>

      {pendingModel !== "EOA" && (
        <label className="mt-2 flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400">
            funder address (from polymarket.com profile)
          </span>
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={pendingAddress}
            onChange={(e) => setPendingAddress(e.target.value)}
            placeholder="0x…"
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 outline-none focus:border-cyan-700"
          />
        </label>
      )}

      {error && <div className="mt-1 font-mono text-[10px] text-rose-300">{error}</div>}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="flex-1 rounded border border-zinc-700 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-300 hover:border-zinc-600"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={!isHexAddress(targetForModel)}
          className="flex-1 rounded border border-cyan-700 bg-cyan-950/60 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-950 disabled:opacity-50"
        >
          apply
        </button>
      </div>
    </div>
  );
}
