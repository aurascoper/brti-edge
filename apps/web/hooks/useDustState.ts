"use client";

import { useEffect, useState } from "react";
import { fetchDustState, type DustStateResponse } from "../lib/fetcher";

export function useDustState(intervalMs = 2_000): DustStateResponse | null {
  const [state, setState] = useState<DustStateResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchDustState();
      if (alive) setState(s);
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return state;
}
