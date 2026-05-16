"use client";

import { useEffect, useState } from "react";
import { fetchKalshiDustState, type KalshiDustState } from "../lib/kalshiFetcher";

export function useKalshiDustState(intervalMs = 1_500): KalshiDustState | null {
  const [state, setState] = useState<KalshiDustState | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchKalshiDustState();
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
