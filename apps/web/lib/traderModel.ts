export type TraderModel = "EOA" | "POLY_PROXY" | "POLY_GNOSIS_SAFE" | "POLY_1271";

export const SIGNATURE_TYPE_BY_MODEL: Record<TraderModel, number> = {
  EOA: 0,
  POLY_PROXY: 1,
  POLY_GNOSIS_SAFE: 2,
  POLY_1271: 3,
};

export const TRADER_MODEL_LABEL: Record<TraderModel, string> = {
  EOA: "standalone EOA",
  POLY_PROXY: "polymarket proxy (legacy)",
  POLY_GNOSIS_SAFE: "polymarket safe (proxy)",
  POLY_1271: "polymarket deposit wallet (new)",
};

export const TRADER_MODEL_HINT: Record<TraderModel, string> = {
  EOA: "fund this wallet directly · USDC + POL for gas here",
  POLY_PROXY: "magic-link / email users · legacy custom proxy",
  POLY_GNOSIS_SAFE: "polymarket.com Safe-proxy users · funds in a Gnosis safe (USDC.e)",
  POLY_1271: "new polymarket.com users · EIP-7702 deposit wallet (pUSD)",
};

// Signing path support. SDK 5.8.1 only supports EOA/POLY_PROXY/POLY_GNOSIS_SAFE.
// POLY_1271 requires clob-client-v2 migration (Phase B).
export const SIGNING_SUPPORTED_BY_MODEL: Record<TraderModel, boolean> = {
  EOA: true,
  POLY_PROXY: true,
  POLY_GNOSIS_SAFE: true,
  POLY_1271: true,
};

const FUNDER_KEY = "polyterminal:funder:v1";
const MODEL_KEY = "polyterminal:trader-model:v1";

interface FunderRecord {
  address: string;
  model: TraderModel;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadFunder(eoa: string | null): FunderRecord | null {
  const s = getStorage();
  if (!s || !eoa) return null;
  try {
    const raw = s.getItem(`${FUNDER_KEY}:${eoa.toLowerCase()}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FunderRecord;
    if (typeof parsed.address !== "string" || !parsed.model) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveFunder(eoa: string, record: FunderRecord): void {
  const s = getStorage();
  if (!s) return;
  try {
    s.setItem(`${FUNDER_KEY}:${eoa.toLowerCase()}`, JSON.stringify(record));
    s.setItem(MODEL_KEY, record.model);
  } catch {}
}

export function clearFunder(eoa: string): void {
  const s = getStorage();
  if (!s) return;
  try {
    s.removeItem(`${FUNDER_KEY}:${eoa.toLowerCase()}`);
  } catch {}
}

export function isHexAddress(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}
