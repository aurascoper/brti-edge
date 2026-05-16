"use client";

import type { TerminalSnapshot } from "@polyterminal/types";
import { Stat, formatPrice, formatUsd } from "@polyterminal/ui";
import { StatusBadge } from "./StatusBadge";
import { WalletButton } from "./WalletButton";
import { statusForScore } from "../lib/status";
import { clearPrimary } from "../lib/fetcher";

export function HeaderBar({ snap }: { snap: TerminalSnapshot | null }) {
  const primary = snap?.primary;
  const stale = snap ? Date.now() - snap.updatedAt : null;
  const status = statusForScore(snap?.primaryScore ?? null);
  const mode = snap?.primaryMode ?? "auto";

  return (
    <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-zinc-500">market</span>
          <ModePill mode={mode} onClear={() => clearPrimary()} />
          <StatusBadge status={status} />
          <span className="font-mono text-[10px] text-zinc-500">
            score {snap?.primaryScore != null ? snap.primaryScore.toFixed(3) : "—"}
          </span>
        </div>
        <div className="font-mono text-base text-zinc-100">
          {primary?.market.question ?? "loading…"}
        </div>
      </div>
      <div className="flex items-center gap-6">
        <Stat label="BTC ref" value={formatPrice(primary?.btcReference ?? null, 2)} />
        <Stat label="mid YES" value={formatPrice(primary?.midpointYes ?? null)} />
        <Stat label="spread" value={formatPrice(primary?.spreadYes ?? null)} />
        <Stat label="vol 24h" value={formatUsd(primary?.market.volume24h ?? null)} />
        <Stat
          label="snap age"
          value={stale === null ? "—" : `${(stale / 1000).toFixed(1)}s`}
          tone={stale !== null && stale > 5_000 ? "down" : "default"}
        />
        <WalletButton />
      </div>
    </header>
  );
}

function ModePill({ mode, onClear }: { mode: "auto" | "manual"; onClear: () => void }) {
  if (mode === "auto") {
    return (
      <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        auto
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClear}
      className="rounded border border-cyan-700 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cyan-300 hover:bg-cyan-950"
      title="return to auto-selection"
    >
      manual · clear
    </button>
  );
}
