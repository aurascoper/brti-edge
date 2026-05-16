"use client";

import { useAccount } from "wagmi";
import { Card, Stat, formatUsd } from "@polyterminal/ui";
import { useCollateralBalance } from "../hooks/useCollateralBalance";
import { usePolymarketPortfolioValue } from "../hooks/usePolymarketAccount";
import { useFunder } from "../hooks/useFunder";
import { FunderSetup } from "./FunderSetup";
import { collateralForModel } from "../lib/collateralForModel";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AccountPanel() {
  const { address, isConnected } = useAccount();
  const funder = useFunder();
  const collateral = collateralForModel(funder.model);
  const { balance: tokenBalance } = useCollateralBalance(
    funder.funderAddress,
    collateral.token,
    collateral.decimals,
  );
  const { value: pmValue } = usePolymarketPortfolioValue(funder.funderAddress);

  if (!isConnected || !address) {
    return (
      <Card title="account">
        <div className="flex h-full items-center justify-center text-xs text-zinc-600">
          connect wallet to view positions
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="account"
      right={
        <span className="font-mono text-[10px] text-zinc-500" title={address}>
          EOA {shortAddr(address)}
        </span>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label={collateral.tokenSymbol}
            value={tokenBalance !== null ? formatUsd(tokenBalance) : "—"}
          />
          <Stat label="portfolio" value={pmValue !== null ? formatUsd(pmValue) : "—"} />
        </div>
        <FunderSetup funder={funder} />
        <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
          read-only · approve allowance off-app
        </div>
      </div>
    </Card>
  );
}
