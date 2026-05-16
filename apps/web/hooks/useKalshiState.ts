"use client";

import { useEffect, useState } from "react";
import { fetchKalshiState, type KalshiWorkerState } from "../lib/kalshiFetcher";

export function useKalshiState(intervalMs = 2_000): KalshiWorkerState | null {
  const [state, setState] = useState<KalshiWorkerState | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchKalshiState();
      if (alive) setState(s);
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return state;
}
