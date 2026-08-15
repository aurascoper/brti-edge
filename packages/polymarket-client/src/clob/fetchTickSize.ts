import { ClobClient, type TickSize } from "@polymarket/clob-client-v2";
import { defaultEndpoints } from "../config";

// getTickSize / getNegRisk live on ClobClient (dist/client.d.ts lines 77-78)
// and hit public endpoints — no L1/L2 auth required — so a bare host string
// is enough; we wrap it in a read-only client. Results are cached per-token
// inside the SDK client instance, so reuse the same client where possible.
function resolveClient(clientOrHost: ClobClient | string): ClobClient {
  if (typeof clientOrHost !== "string") return clientOrHost;
  return new ClobClient({ host: clientOrHost || defaultEndpoints.clob, chain: 137 as 137 | 80002 });
}

// Normalized to a number (the SDK returns the string union "0.1" | "0.01" | ...).
export async function fetchTickSize(
  clientOrHost: ClobClient | string,
  tokenId: string,
): Promise<number> {
  const raw: TickSize = await resolveClient(clientOrHost).getTickSize(tokenId);
  return Number(raw);
}

export async function fetchNegRisk(
  clientOrHost: ClobClient | string,
  tokenId: string,
): Promise<boolean> {
  return resolveClient(clientOrHost).getNegRisk(tokenId);
}
