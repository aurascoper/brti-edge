"use client";

import { useQuery } from "@tanstack/react-query";
import {
  fetchPositions,
  fetchPortfolioValue,
  fetchTrades,
  type DataApiPosition,
  type DataApiTrade,
} from "@polyterminal/polymarket-client";

export function usePolymarketPositions(target: string | null): {
  positions: DataApiPosition[];
  isLoading: boolean;
  error: unknown;
} {
  const q = useQuery({
    queryKey: ["polymarket", "positions", target],
    enabled: Boolean(target),
    queryFn: () => fetchPositions({ user: target!, limit: 50, sizeThreshold: 0.01 }),
    refetchInterval: 30_000,
  });
  return { positions: q.data ?? [], isLoading: q.isLoading, error: q.error };
}

export function usePolymarketPortfolioValue(target: string | null): {
  value: number | null;
  isLoading: boolean;
} {
  const q = useQuery({
    queryKey: ["polymarket", "value", target],
    enabled: Boolean(target),
    queryFn: () => fetchPortfolioValue(target!),
    refetchInterval: 30_000,
  });
  return { value: q.data ?? null, isLoading: q.isLoading };
}

export function usePolymarketTrades(target: string | null): {
  trades: DataApiTrade[];
  isLoading: boolean;
} {
  const q = useQuery({
    queryKey: ["polymarket", "trades", target],
    enabled: Boolean(target),
    queryFn: () => fetchTrades({ user: target!, limit: 25 }),
    refetchInterval: 60_000,
  });
  return { trades: q.data ?? [], isLoading: q.isLoading };
}
