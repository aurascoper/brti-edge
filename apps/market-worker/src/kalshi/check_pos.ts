import { KalshiClient } from "@polyterminal/kalshi-client";
if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY_PEM) {
  throw new Error("G0 isolation: supply KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PEM in brti-edge env (cross-repo .env fallback disabled).");
}
const c = new KalshiClient({ apiKeyId: process.env.KALSHI_API_KEY_ID!, privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM! });
// Both expired markets
for (const t of ["KXBTC15M-26MAY151145-45", "KXSOL15M-26MAY151145-45"]) {
  const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`);
  const m = (await r.json() as any).market;
  console.log(`${t}: status=${m?.status} result=${JSON.stringify(m?.result)} expiration_value=${m?.expiration_value} floor_strike=${m?.floor_strike}`);
}
const pos = await c.listPositions();
console.log("\nopen positions:", JSON.stringify((pos as any).market_positions || pos, null, 2));
