import { http, createConfig, type Config } from "wagmi";
import { mainnet, polygon, arbitrum } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
const isBrowser = typeof window !== "undefined";

export const HAS_WALLETCONNECT = projectId.length > 0;

const baseConnectors = [injected({ target: "metaMask" }), injected()];

const wcConnector =
  HAS_WALLETCONNECT && isBrowser
    ? [
        walletConnect({
          projectId,
          showQrModal: true,
          metadata: {
            name: "polyterminal",
            description: "BTC-focused Polymarket execution terminal",
            url: window.location.origin,
            icons: [],
          },
        }),
      ]
    : [];

export const wagmiConfig: Config = createConfig({
  chains: [polygon, mainnet, arbitrum],
  connectors: [...baseConnectors, ...wcConnector],
  transports: {
    [polygon.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
  },
  ssr: true,
});

// Polymarket collateral on Polygon.
//
// Two parallel flows exist:
//   Safe-proxy users (sigType=2)  → legacy CLOB. Collateral: USDC.e. Exchange: 0x4bFb…982E.
//                                   This is what polymarket.com browser-wallet users use today.
//                                   The official @polymarket/clob-client SDK still defaults to these.
//   Deposit-wallet users (sigType=3) → new flow. Collateral: pUSD.    Exchange: 0xE111…996B.
//                                   For new pure-API users.
//
// Docs: https://docs.polymarket.com/resources/contracts
//       https://docs.polymarket.com/api-reference/authentication
//
// We default to the Safe-proxy path because that's what the user is using.
// To switch to the deposit-wallet path, override these env vars.
export const POLYMARKET_COLLATERAL =
  (process.env.NEXT_PUBLIC_POLYMARKET_COLLATERAL as `0x${string}` | undefined) ??
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

export const POLYMARKET_COLLATERAL_SYMBOL =
  process.env.NEXT_PUBLIC_POLYMARKET_COLLATERAL_SYMBOL ?? "USDC.e";

export const POLYMARKET_EXCHANGE =
  (process.env.NEXT_PUBLIC_POLYMARKET_EXCHANGE as `0x${string}` | undefined) ??
  "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

export const POLYMARKET_NEG_RISK_EXCHANGE =
  (process.env.NEXT_PUBLIC_POLYMARKET_NEG_RISK_EXCHANGE as `0x${string}` | undefined) ??
  "0xC5d563A36AE78145C45a50134d48A1215220f80a";
