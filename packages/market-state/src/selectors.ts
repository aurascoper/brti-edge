import type { MarketSnapshot, TerminalSnapshot } from "@polyterminal/types";

export function selectPrimary(s: TerminalSnapshot): MarketSnapshot | null {
  return s.primary;
}

export function selectMostDislocated(s: TerminalSnapshot, n = 5): MarketSnapshot[] {
  const all = [s.primary, ...s.related].filter((m): m is MarketSnapshot => !!m);
  return all
    .filter((m) => m.dislocation !== null)
    .sort((a, b) => Math.abs(b.dislocation!) - Math.abs(a.dislocation!))
    .slice(0, n);
}

export function selectStaleMs(s: TerminalSnapshot, now = Date.now()): number {
  return now - s.updatedAt;
}
