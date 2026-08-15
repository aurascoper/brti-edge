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

// L1 headers and /auth responses contain live credentials (POLY_SIGNATURE,
// apiKey/secret/passphrase) — never log payloads. Status-only debug lines are
// gated behind POLYMARKET_AUTH_DEBUG=1 (default silent).
function debugAuth(msg: string): void {
  if (process.env.POLYMARKET_AUTH_DEBUG === "1") console.error(`[polymarket-auth] ${msg}`);
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
  debugAuth("L1 headers built for funder derivation");
  const created = await fetchAuthDetail(`${host}/auth/api-key`, "POST", headers);
  debugAuth(`POST /auth/api-key status=${created.status}`);
  if (created.body && (created.body as ApiKeyRaw).apiKey) {
    return mapCreds(created.body as ApiKeyRaw);
  }
  const derived = await fetchAuthDetail(`${host}/auth/derive-api-key`, "GET", headers);
  debugAuth(`GET /auth/derive-api-key status=${derived.status}`);
  if (derived.body && (derived.body as ApiKeyRaw).apiKey) {
    return mapCreds(derived.body as ApiKeyRaw);
  }
  const detail = `create: status=${created.status} body=${JSON.stringify(redactCreds(created.body)).slice(0, 200)} | derive: status=${derived.status} body=${JSON.stringify(redactCreds(derived.body)).slice(0, 200)}`;
  throw new Error(`API key for funder failed — ${detail}`);
}

// Bodies embedded in error text could carry live credentials if the /auth
// response schema ever drifts (today creds only appear under the checked
// apiKey field on success) — redact credential-shaped keys before stringifying.
const SENSITIVE_KEY_RE = /^(api[-_]?key|secret|passphrase|password|token)$/i;

function redactCreds(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(redactCreds);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "<redacted>" : redactCreds(v);
  }
  return out;
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
    // Read the body ONCE as text — a Response body cannot be read twice with
    // Node's fetch, so a res.json() that fails leaves res.text() throwing and
    // the actual server response (Cloudflare HTML, plain-text 429) invisible.
    let body: unknown = null;
    try {
      const text = await res.text();
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    } catch {
      body = null;
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
