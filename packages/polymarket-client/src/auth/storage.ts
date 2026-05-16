import type { TradingSession } from "./types";

const KEY_PREFIX = "polyterminal:session:";

interface MinimalStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  length: number;
  key(i: number): string | null;
}

function getStorage(): MinimalStorage | null {
  const g = globalThis as { sessionStorage?: MinimalStorage };
  return g.sessionStorage ?? null;
}

function keyFor(address: string): string {
  return KEY_PREFIX + address.toLowerCase();
}

export function loadSession(address: string): TradingSession | null {
  const s = getStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(keyFor(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TradingSession;
    if (!parsed.creds?.key || !parsed.creds?.secret || !parsed.creds?.passphrase) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: TradingSession): void {
  const s = getStorage();
  if (!s) return;
  try {
    s.setItem(keyFor(session.address), JSON.stringify(session));
  } catch {}
}

export function clearSession(address?: string): void {
  const s = getStorage();
  if (!s) return;
  try {
    if (address) {
      s.removeItem(keyFor(address));
      return;
    }
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {}
}
