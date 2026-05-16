"use client";

import { useEffect, useState } from "react";
import type { TerminalSnapshot } from "@polyterminal/types";
import { fetchSnapshot } from "../lib/fetcher";

export function useSnapshot(intervalMs = 1_000): TerminalSnapshot | null {
  const [snap, setSnap] = useState<TerminalSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchSnapshot();
      if (alive && s) setSnap(s);
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return snap;
}
