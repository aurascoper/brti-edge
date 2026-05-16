"use client";

import type { MarketSnapshot, TerminalSnapshot } from "@polyterminal/types";
import { Card, FreshnessBadge, formatPrice, formatUsd } from "@polyterminal/ui";
import { clearPrimary, setPrimary } from "../lib/fetcher";
import { statusForScore, STATUS_DOT, STATUS_TEXT } from "../lib/status";

export function WatchlistRail({ snap }: { snap: TerminalSnapshot | null }) {
  const watchlist = (snap?.watchlist ?? []).filter((m) => m.freshness !== "stale");
  const mode = snap?.primaryMode ?? "auto";

  return (
    <Card
      title="watchlist"
      right={
        <button
          type="button"
          onClick={() => clearPrimary()}
          disabled={mode === "auto"}
          className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition ${
            mode === "auto"
              ? "cursor-default border-zinc-800 text-zinc-600"
              : "border-cyan-700 text-cyan-300 hover:bg-cyan-950"
          }`}
        >
          {mode === "auto" ? "auto" : "manual · clear"}
        </button>
      }
    >
      <div className="flex h-full flex-col gap-1 overflow-y-auto pr-1">
        {watchlist.length === 0 && (
          <div className="text-xs text-zinc-600">no eligible watchlist markets</div>
        )}
        {watchlist.map((m) => (
          <WatchRow key={m.market.conditionId} snap={m} />
        ))}
      </div>
    </Card>
  );
}

function WatchRow({ snap }: { snap: MarketSnapshot }) {
  const status = statusForScore(snap.score);
  const yes = formatPrice(snap.midpointYes ?? snap.market.tokens[0]?.price ?? null, 3);
  const vol = snap.market.volume24h;
  const liq = snap.market.liquidity;

  return (
    <button
      type="button"
      onClick={() => setPrimary(snap.market.conditionId)}
      className="group flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-left transition hover:border-cyan-800 hover:bg-zinc-900"
      title="promote to primary"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 font-mono text-[11px] leading-tight text-zinc-200 group-hover:text-zinc-50">
          {snap.market.question}
        </span>
        <span className="shrink-0 font-mono text-xs text-zinc-100">{yes}</span>
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
        <span className={`inline-flex items-center gap-1 ${STATUS_TEXT[status]}`}>
          <span className={`inline-block h-1 w-1 rounded-full ${STATUS_DOT[status]}`} />
          {snap.score !== null ? snap.score.toFixed(3) : "—"}
        </span>
        <FreshnessBadge freshness={snap.freshness} ageSec={snap.bookAgeSec} />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
        <span>vol {formatUsd(vol)}</span>
        <span>liq {formatUsd(liq)}</span>
      </div>
    </button>
  );
}
