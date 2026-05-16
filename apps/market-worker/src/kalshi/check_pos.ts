import { readFileSync } from "fs";
if (!process.env.KALSHI_API_KEY_ID) {
  const t = readFileSync("/Users/aurascoper/Developer/live_trading/.env", "utf8");
  for (const l of t.split("\n")) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && m[1].startsWith("KALSHI_") && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
import { KalshiClient } from "@polyterminal/kalshi-client";
const c = new KalshiClient({ apiKeyId: process.env.KALSHI_API_KEY_ID!, privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM! });
// Both expired markets
for (const t of ["KXBTC15M-26MAY151145-45", "KXSOL15M-26MAY151145-45"]) {
  const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`);
  const m = (await r.json() as any).market;
  console.log(`${t}: status=${m?.status} result=${JSON.stringify(m?.result)} expiration_value=${m?.expiration_value} floor_strike=${m?.floor_strike}`);
}
const pos = await c.listPositions();
console.log("\nopen positions:", JSON.stringify((pos as any).market_positions || pos, null, 2));
