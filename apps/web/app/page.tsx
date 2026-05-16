"use client";

import { KalshiPanel } from "../components/KalshiPanel";

// Polymarket-era panels (CandlePanel, OrderBookPanel, WatchlistRail,
// AccountPanel, NetworkGraphPanel, OrderTicket, PnlPanel, PositionsPanel,
// HeaderBar) are intentionally not mounted. The Polymarket worker is stopped
// and that venue is research-only. The components remain in the repo for
// reference but the live UI is Kalshi-only.

export default function Page() {
  return (
    <main className="flex h-screen flex-col bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
        <span>polyterminal · kalshi</span>
        <span className="text-zinc-600">localhost:3000 · worker :4001</span>
      </header>
      <div className="flex-1 p-2">
        <KalshiPanel />
      </div>
    </main>
  );
}
