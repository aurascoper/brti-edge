// Verify Tier-1 expansion: 9 crypto 15m series visible, execution gated to BTC only.
//
//   pnpm dlx tsx src/smoke-multi-series.ts

import { readFileSync } from "node:fs";
import { CRYPTO_15M_SERIES, isExecutionAllowed, KalshiAdapter } from "./index";

if (!process.env.KALSHI_API_KEY_ID) {
  const envText = readFileSync("/Users/aurascoper/Developer/live_trading/.env", "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[1]?.startsWith("KALSHI_")) {
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

async function main() {
  console.log("=== Configured 15m crypto series ===");
  for (const s of CRYPTO_15M_SERIES) {
    console.log(
      `  ${s.series.padEnd(12)} ${s.underlying.padEnd(10)} cex=${s.cexSpotSymbol.padEnd(10)} exec=${s.executionAllowed}`,
    );
  }

  const a = new KalshiAdapter();
  console.log("\n=== Live scan across all 9 series ===");
  const mkts = await a.listAllCrypto15mOpen(3);
  console.log(`total open markets: ${mkts.length}`);
  const bySeries = new Map<string, typeof mkts>();
  for (const m of mkts) {
    const series = m.ticker.split("-")[0]!;
    if (!bySeries.has(series)) bySeries.set(series, []);
    bySeries.get(series)!.push(m);
  }
  for (const s of CRYPTO_15M_SERIES) {
    const ms = bySeries.get(s.series) ?? [];
    console.log(`  ${s.series.padEnd(12)} open=${ms.length}  exec=${isExecutionAllowed(s.series)}`);
    for (const m of ms.slice(0, 1)) {
      console.log(`    ${m.ticker.padEnd(32)} strike=${m.strike}  close=${m.close_time}`);
    }
  }

  console.log("\n=== Execution gate verification ===");
  // 1) allowOrders=false (default) — should always throw
  try {
    await a.submitOrder({ ticker: "KXBTC15M-X", side: "no", action: "buy", type: "limit", count: 1, price: 0.5 });
    console.log("  FAIL: BTC didn't throw with allowOrders=false");
  } catch (e) {
    console.log(`  ✓ allowOrders=false blocks BTC: ${(e as Error).message.slice(0, 90)}`);
  }

  // 2) allowOrders=true, non-BTC series — should be gated by executionAllowed=false
  const liveAdapter = new KalshiAdapter({ allowOrders: true });
  try {
    await liveAdapter.submitOrder({
      ticker: "KXETH15M-X",
      side: "no",
      action: "buy",
      type: "limit",
      count: 1,
      price: 0.5,
    });
    console.log("  FAIL: ETH didn't throw despite executionAllowed=false");
  } catch (e) {
    console.log(`  ✓ ETH gated even with allowOrders=true: ${(e as Error).message.slice(0, 90)}`);
  }

  // 3) allowOrders=true, BTC — passes gate; throws because impl is Phase 2.2
  try {
    await liveAdapter.submitOrder({
      ticker: "KXBTC15M-X",
      side: "no",
      action: "buy",
      type: "limit",
      count: 1,
      price: 0.5,
    });
    console.log("  FAIL: BTC didn't throw (impl is supposed to be missing)");
  } catch (e) {
    console.log(`  ✓ BTC passes gate, hits NotImplemented: ${(e as Error).message.slice(0, 90)}`);
  }

  console.log("\nmulti-series smoke test passed ✓");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
