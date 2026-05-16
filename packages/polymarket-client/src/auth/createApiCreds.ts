import { ClobClient, createL1Headers } from "@polymarket/clob-client-v2";
import type { WalletClient } from "viem";
import { defaultEndpoints } from "../config";
import {
  SIGNATURE_TYPE_EOA,
  SIGNATURE_TYPE_POLY_1271,
  type ApiCreds,
  type TradingSession,
} from "./types";

export type SdkSigner = WalletClient;

export interface DeriveCredsOptions {
  signer: SdkSigner;
  chainId: number;
  funderAddress?: string;
  signatureType?: number;
  host?: string;
}

function resolveSignerAddress(signer: SdkSigner): string {
  const addr = signer.account?.address;
  if (!addr) throw new Error("WalletClient.account.address missing");
  return addr.toLowerCase();
}

export async function deriveTradingSession(opts: DeriveCredsOptions): Promise<TradingSession> {
  const host = opts.host ?? defaultEndpoints.clob;
  const signatureType = opts.signatureType ?? SIGNATURE_TYPE_EOA;
  const address = resolveSignerAddress(opts.signer);
  const funderAddress = (opts.funderAddress ?? address).toLowerCase();

  const creds =
    signatureType === SIGNATURE_TYPE_POLY_1271
      ? await deriveApiKeyForFunder(opts.signer, opts.chainId, funderAddress, host)
      : await deriveApiKeyForEoa(opts.signer, opts.chainId, host);

  return {
    address,
    funderAddress,
    signatureType,
    creds,
    chainId: opts.chainId,
    derivedAt: Date.now(),
  };
}

async function deriveApiKeyForEoa(
  signer: SdkSigner,
  chainId: number,
  host: string,
): Promise<ApiCreds> {
  const l1 = new ClobClient({ host, chain: chainId as 137 | 80002, signer });
  return (await l1.createOrDeriveApiKey()) as ApiCreds;
}

// For sigType=POLY_1271 (EIP-7702 deposit wallet): the SDK's createOrDeriveApiKey
// hardcodes the L1 header to the EOA, so the L2 key gets bound to the EOA.
// Orders are then signed for the deposit-wallet address, and Polymarket rejects
// every submission with "the order signer address has to be the address of the
// API KEY". Bypass the SDK helper by building L1 headers with the funder
// address ourselves, then hit /auth/api-key (create) and /auth/derive-api-key
// (fallback) directly.
async function deriveApiKeyForFunder(
  signer: SdkSigner,
  chainId: number,
  funderAddress: string,
  host: string,
): Promise<ApiCreds> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = 0;
  const headers = await createL1Headers(signer, chainId, nonce, ts, funderAddress);
  console.log("[deriveApiKeyForFunder] headers:", headers);
  const created = await fetchAuthDetail(`${host}/auth/api-key`, "POST", headers);
  console.log("[deriveApiKeyForFunder] POST /auth/api-key →", created);
  if (created.body && (created.body as ApiKeyRaw).apiKey) {
    return mapCreds(created.body as ApiKeyRaw);
  }
  const derived = await fetchAuthDetail(`${host}/auth/derive-api-key`, "GET", headers);
  console.log("[deriveApiKeyForFunder] GET /auth/derive-api-key →", derived);
  if (derived.body && (derived.body as ApiKeyRaw).apiKey) {
    return mapCreds(derived.body as ApiKeyRaw);
  }
  const detail = `create: status=${created.status} body=${JSON.stringify(created.body).slice(0, 200)} | derive: status=${derived.status} body=${JSON.stringify(derived.body).slice(0, 200)}`;
  throw new Error(`API key for funder failed — ${detail}`);
}

interface ApiKeyRaw {
  apiKey?: string;
  secret?: string;
  passphrase?: string;
}

interface AuthDetail {
  status: number;
  body: unknown;
}

async function fetchAuthDetail(
  url: string,
  method: "POST" | "GET",
  headers: Record<string, unknown>,
): Promise<AuthDetail> {
  try {
    const res = await fetch(url, {
      method,
      headers: headers as Record<string, string>,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {}
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { fetchError: String(err) } };
  }
}

function mapCreds(raw: ApiKeyRaw): ApiCreds {
  if (!raw.apiKey || !raw.secret || !raw.passphrase) {
    throw new Error("incomplete API key response from Polymarket");
  }
  return { key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase };
}
