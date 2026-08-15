import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import { deriveTradingSession, type DeriveCredsOptions, type SdkSigner } from "./createApiCreds";
import type { TradingSession } from "./types";

// Headless (Node) session bootstrap: builds a viem WalletClient from a raw
// private key and derives L2 API creds via deriveTradingSession.
//
// The returned session is held IN MEMORY ONLY — deliberately no persistence.
// auth/storage.ts is sessionStorage-backed and silently no-ops in Node, and
// writing ApiCreds (key/secret/passphrase) to a file would leak a live
// trading credential into shell history, backups, or the repo. Re-derive per
// process instead; createOrDeriveApiKey is idempotent for a given wallet.

export interface HeadlessSessionOptions {
  privateKey: string; // hex, with or without 0x prefix
  funderAddress?: string;
  signatureType?: number;
  chainId?: number; // 137 (default) or 80002
  host?: string;
}

export interface HeadlessSession {
  session: TradingSession;
  signer: SdkSigner;
}

export async function createHeadlessSession(
  opts: HeadlessSessionOptions,
): Promise<HeadlessSession> {
  const pk = (opts.privateKey.startsWith("0x")
    ? opts.privateKey
    : `0x${opts.privateKey}`) as `0x${string}`;
  const chainId = opts.chainId ?? 137;
  const signer: SdkSigner = createWalletClient({
    account: privateKeyToAccount(pk),
    chain: chainId === 80002 ? polygonAmoy : polygon,
    transport: http(),
  });
  const derive: DeriveCredsOptions = { signer, chainId };
  if (opts.funderAddress !== undefined) derive.funderAddress = opts.funderAddress;
  if (opts.signatureType !== undefined) derive.signatureType = opts.signatureType;
  if (opts.host !== undefined) derive.host = opts.host;
  const session = await deriveTradingSession(derive);
  return { session, signer };
}
