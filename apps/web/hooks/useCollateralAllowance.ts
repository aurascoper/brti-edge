"use client";

import { erc20Abi, formatUnits } from "viem";
import { useReadContract } from "wagmi";

export function useCollateralAllowance(
  target: `0x${string}` | null,
  token: `0x${string}`,
  spender: `0x${string}`,
  decimals = 6,
): { allowance: number | null; isLoading: boolean } {
  const { data, isLoading } = useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: "allowance",
    args: target ? [target, spender] : undefined,
    query: {
      enabled: Boolean(target),
      refetchInterval: 30_000,
    },
  });
  if (!target || data === undefined) return { allowance: null, isLoading };
  return { allowance: Number(formatUnits(data as bigint, decimals)), isLoading };
}
