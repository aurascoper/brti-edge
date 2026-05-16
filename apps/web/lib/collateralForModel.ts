import {
  POLYMARKET_COLLATERAL,
  POLYMARKET_COLLATERAL_SYMBOL,
  POLYMARKET_EXCHANGE,
} from "./wagmi";
import type { TraderModel } from "./traderModel";

export interface CollateralConfig {
  token: `0x${string}`;
  tokenSymbol: string;
  exchange: `0x${string}`;
  decimals: number;
}

// pUSD and the new CTF Exchange are the deposit-wallet flow contracts.
// Source: https://docs.polymarket.com/resources/contracts
const DEPOSIT_WALLET_CONFIG: CollateralConfig = {
  token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  tokenSymbol: "pUSD",
  exchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  decimals: 6,
};

export function collateralForModel(model: TraderModel): CollateralConfig {
  if (model === "POLY_1271") return DEPOSIT_WALLET_CONFIG;
  // EOA / POLY_PROXY / POLY_GNOSIS_SAFE — legacy flow.
  // Driven by env vars so it's still configurable.
  return {
    token: POLYMARKET_COLLATERAL,
    tokenSymbol: POLYMARKET_COLLATERAL_SYMBOL,
    exchange: POLYMARKET_EXCHANGE,
    decimals: 6,
  };
}
