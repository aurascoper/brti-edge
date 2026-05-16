"use client";

import { useEffect, useRef, useState } from "react";
import type { OutcomeToken } from "@polyterminal/types";
import { fetchMarkets, gammaMarketToDescriptor } from "@polyterminal/polymarket-client";

// Lazy fetch of MarketDescriptor.tokens for conditionIds that are missing
// from the worker snapshot. Used by DustPanel as a fallback when
// pickTokenId(snap, candidate) returns null.
//
// Cache is per-hook-instance (one DustPanel mount). Each conditionId is
// fetched at most once; subsequent renders read from the cache. Failed
// fetches are remembered so we don't hammer Gamma on a bad id.

export type MarketTokenState =
  | { status: "loading" }
  | { status: "ready"; tokens: OutcomeToken[] }
  | { status: "missing" };

export function useMarketTokens(
  conditionIds: string[],
): Map<string, MarketTokenState> {
  const [cache, setCache] = useState<Map<string, MarketTokenState>>(new Map());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inFlight = useRef<Set<string>>(new Set());
  const key = [...new Set(conditionIds)].sort().join("|");

  useEffect(() => {
    const wanted = conditionIds.filter(
      (id) =>
        id &&
        id.startsWith("0x") &&
        id.length > 10 && // skip synthetic test ids like "0xTEST"
        !cacheRef.current.has(id) &&
        !inFlight.current.has(id),
    );
    if (wanted.length === 0) return;
    wanted.forEach((id) => inFlight.current.add(id));
    setCache((prev) => {
      const next = new Map(prev);
      for (const id of wanted) if (!next.has(id)) next.set(id, { status: "loading" });
      return next;
    });

    (async () => {
      try {
        const rows = await fetchMarkets({ conditionIds: wanted });
        const seen = new Set<string>();
        setCache((prev) => {
          const next = new Map(prev);
          for (const m of rows) {
            const desc = gammaMarketToDescriptor(m);
            if (desc.tokens.length > 0) {
              next.set(desc.conditionId, { status: "ready", tokens: desc.tokens });
              seen.add(desc.conditionId);
            }
          }
          for (const id of wanted) {
            if (!seen.has(id)) next.set(id, { status: "missing" });
          }
          return next;
        });
      } catch {
        setCache((prev) => {
          const next = new Map(prev);
          for (const id of wanted) next.set(id, { status: "missing" });
          return next;
        });
      } finally {
        wanted.forEach((id) => inFlight.current.delete(id));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return cache;
}
