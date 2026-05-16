import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// Kalshi signing rules (discovered empirically 2026-05-14, see docs/research):
//   - signature input = timestamp_ms_string + http_method + path
//   - path INCLUDES the /trade-api/v2 prefix
//   - path does NOT include query string
//   - algorithm = RSASSA-PSS, hash = SHA-256, mgf1 = SHA-256
//   - salt length = 32 (digest length) — Kalshi accepts variable salts
//   - signature is base64-encoded
//   - timestamp is current Unix time in milliseconds, as string
//
// Required headers on every authenticated request:
//   KALSHI-ACCESS-KEY        the key id (UUID string)
//   KALSHI-ACCESS-SIGNATURE  base64 of the signature
//   KALSHI-ACCESS-TIMESTAMP  matching ms timestamp

export interface KalshiCredentials {
  keyId: string;
  privateKey: KeyObject;
}

export function loadCredentialsFromEnv(): KalshiCredentials {
  const keyId = process.env.KALSHI_API_KEY_ID;
  const path = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!keyId) throw new Error("KALSHI_API_KEY_ID env not set");
  if (!path) throw new Error("KALSHI_PRIVATE_KEY_PATH env not set");
  const pem = readFileSync(path);
  const privateKey = createPrivateKey(pem);
  return { keyId, privateKey };
}

export interface SignedHeaders {
  "KALSHI-ACCESS-KEY": string;
  "KALSHI-ACCESS-SIGNATURE": string;
  "KALSHI-ACCESS-TIMESTAMP": string;
  accept: "application/json";
  "content-type"?: "application/json";
}

export function signRequest(
  creds: KalshiCredentials,
  method: "GET" | "POST" | "DELETE" | "PUT",
  pathWithPrefix: string,
): SignedHeaders {
  if (!pathWithPrefix.startsWith("/trade-api/v2/")) {
    // Defensive: catch the most common mistake before Kalshi 401s on us.
    throw new Error(
      `signed path must start with /trade-api/v2/ (got "${pathWithPrefix}"). ` +
        `Query strings must be stripped before signing.`,
    );
  }
  const ts = Date.now().toString();
  const message = `${ts}${method}${pathWithPrefix}`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  const signature = signer.sign(
    {
      key: creds.privateKey,
      padding: 6, // RSA_PKCS1_PSS_PADDING (constants.RSA_PKCS1_PSS_PADDING)
      saltLength: 32, // PSS_DIGEST_LENGTH
    },
    "base64",
  );
  return {
    "KALSHI-ACCESS-KEY": creds.keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    accept: "application/json",
  };
}

// Strip query string from a relative path for signing.
export function pathForSigning(pathPrefix: string, relativePath: string): string {
  const noQuery = relativePath.split("?")[0]!;
  return pathPrefix + noQuery;
}
