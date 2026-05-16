"use client";

import { erc20Abi, formatUnits } from "viem";
import { useReadContract } from "wagmi";

export function useCollateralBalance(
  target: `0x${string}` | null,
  token: `0x${string}`,
  decimals = 6,
): { balance: number | null; isLoading: boolean } {
  const { data, isLoading } = useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: "balanceOf",
    args: target ? [target] : undefined,
    query: {
      enabled: Boolean(target),
      refetchInterval: 15_000,
    },
  });
  if (!target || data === undefined) return { balance: null, isLoading };
  return { balance: Number(formatUnits(data as bigint, decimals)), isLoading };
}
