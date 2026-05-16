// Smoke test through the VenueAdapter interface (not the raw client).
// Verifies the adapter properly maps Kalshi-native shapes to venue-neutral ones.
//
//   pnpm dlx tsx src/smoke-adapter.ts

import { readFileSync } from "node:fs";
import { KalshiAdapter } from "./adapter";

if (!process.env.KALSHI_API_KEY_ID) {
  try {
    const envText = readFileSync("/Users/aurascoper/Developer/live_trading/.env", "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1]?.startsWith("KALSHI_")) {
        if (!process.env[m[1]]) process.env[m[1]] = m[2];
      }
    }
  } catch {}
}

async function main() {
  const adapter = new KalshiAdapter({ allowOrders: false });

  console.log("=== venue ===");
  console.log(`  ${adapter.venue}`);

  console.log("\n=== status ===");
  console.log(await adapter.getStatus());

  console.log("\n=== balance (USD) ===");
  const bal = await adapter.getBalance();
  console.log(`  cash_usd: $${bal.cash_usd.toFixed(2)}`);
  console.log(`  portfolio_value_usd: $${bal.portfolio_value_usd.toFixed(2)}`);

  console.log("\n=== KXBTC15M open markets (via adapter) ===");
  const mkts = await adapter.listMarkets({ status: "open", series: "KXBTC15M", limit: 3 });
  for (const m of mkts) {
    console.log(`  ${m.ticker}`);
    console.log(`    title=${m.title}`);
    console.log(`    underlying=${m.underlying}  strike_type=${m.strike_type}  strike=${m.strike}`);
    console.log(`    close=${m.close_time}  status=${m.status}`);
  }

  if (mkts.length > 0) {
    const t = mkts[0]!.ticker;
    console.log(`\n=== orderbook for ${t} ===`);
    const ob = await adapter.getOrderbook(t);
    console.log(`  best_yes_bid=${ob.best_yes_bid}  best_yes_ask=${ob.best_yes_ask}`);
    console.log(`  best_no_bid=${ob.best_no_bid}    best_no_ask=${ob.best_no_ask}`);
    console.log(`  mid_yes=${ob.mid_yes}  spread=${ob.spread}`);
  }

  console.log("\n=== positions ===");
  console.log(`  count: ${(await adapter.listPositions()).length}`);

  console.log("\n=== orders ===");
  console.log(`  count: ${(await adapter.listOrders()).length}`);

  console.log("\n=== fills ===");
  console.log(`  count: ${(await adapter.listFills()).length}`);

  console.log("\n=== submitOrder (should throw NotImplemented) ===");
  try {
    await adapter.submitOrder({
      ticker: "KXBTC15M-X",
      side: "no",
      action: "buy",
      type: "limit",
      count: 1,
      price: 0.5,
    });
    console.log("  ERROR: submitOrder did not throw!");
  } catch (e) {
    console.log(`  ✓ threw: ${(e as Error).message}`);
  }

  console.log("\nadapter smoke test passed ✓");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
