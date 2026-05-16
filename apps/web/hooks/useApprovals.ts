"use client";

import { useAccount, useChainId } from "wagmi";
import { polygon } from "wagmi/chains";
import { useCollateralBalance } from "./useCollateralBalance";
import { useCollateralAllowance } from "./useCollateralAllowance";
import { computeApprovalState, type ApprovalState, type Side } from "../lib/approvalState";
import type { CollateralConfig } from "../lib/collateralForModel";

export interface UseApprovalsResult {
  state: ApprovalState;
  collateralBalance: number | null;
  collateralAllowance: number | null;
}

export function useApprovals(opts: {
  side: Side;
  cost: number | null;
  funder: `0x${string}` | null;
  collateral: CollateralConfig;
}): UseApprovalsResult {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { balance: collateralBalance } = useCollateralBalance(
    opts.funder,
    opts.collateral.token,
    opts.collateral.decimals,
  );
  const { allowance: collateralAllowance } = useCollateralAllowance(
    opts.funder,
    opts.collateral.token,
    opts.collateral.exchange,
    opts.collateral.decimals,
  );

  const state = computeApprovalState({
    side: opts.side,
    isConnected,
    onPolygon: chainId === polygon.id,
    cost: opts.cost,
    collateralBalance,
    collateralAllowance,
    tokenSymbol: opts.collateral.tokenSymbol,
  });

  return { state, collateralBalance, collateralAllowance };
}
