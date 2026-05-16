// Smoke test: not exported, run directly with tsx for verification.
//
//   cd /Users/aurascoper/Developer/polyterminal/packages/kalshi-client
//   pnpm dlx tsx src/smoke.ts
//
// Requires KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH in env (loaded from
// ~/Developer/live_trading/.env if you source it first).

import { readFileSync } from "node:fs";
import { KalshiClient } from "./client";

// Load env from ~/Developer/live_trading/.env if not already set.
if (!process.env.KALSHI_API_KEY_ID) {
  try {
    const envText = readFileSync("/Users/aurascoper/Developer/live_trading/.env", "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1]?.startsWith("KALSHI_")) {
        if (!process.env[m[1]]) process.env[m[1]] = m[2];
      }
    }
  } catch {
    // ignore; will error from constructor if creds missing
  }
}

async function main() {
  const client = new KalshiClient();

  console.log("=== exchange status (public) ===");
  console.log(await client.exchangeStatus());

  console.log("\n=== balance (signed) ===");
  const bal = await client.getBalance();
  console.log(`  raw cents: ${bal.balance}`);
  console.log(`  breakdown: ${JSON.stringify(bal.balance_breakdown)}`);
  console.log(`  portfolio_value cents: ${bal.portfolio_value}`);

  console.log("\n=== positions (signed) ===");
  const pos = await client.listPositions({ limit: 5 });
  console.log(`  market_positions: ${pos.market_positions.length}`);
  console.log(`  event_positions:  ${pos.event_positions.length}`);

  console.log("\n=== orders (signed) ===");
  const ord = await client.listOrders({ limit: 5 });
  console.log(`  orders: ${ord.orders.length}`);

  console.log("\n=== fills (signed) ===");
  const fills = await client.listFills({ limit: 5 });
  console.log(`  fills: ${fills.fills.length}`);

  console.log("\n=== KXBTC15M open markets (public) ===");
  const mkts = await client.listKxbtc15mOpen(3);
  for (const m of mkts) {
    console.log(`  ${m.ticker}  close=${m.close_time}  title="${m.title.slice(0, 60)}"`);
  }

  if (mkts.length > 0) {
    const ticker = mkts[0]!.ticker;
    const m = mkts[0]!;
    console.log(`\n=== contract semantics for ${ticker} ===`);
    console.log(`  title:         ${m.title}`);
    console.log(`  yes_sub_title: ${m.yes_sub_title ?? "(none)"}`);
    console.log(`  floor_strike:  ${m.floor_strike ?? "(none)"}`);
    console.log(`  cap_strike:    ${m.cap_strike ?? "(none)"}`);
    console.log(`  strike_type:   ${m.strike_type ?? "(none)"}`);
    console.log(`  close_time:    ${m.close_time}`);

    console.log(`\n=== orderbook top-of-book (normalized) ===`);
    const ob = await client.getOrderbook(ticker);
    console.log(`  yes_bids depth: ${ob.yes_bids.length} levels`);
    console.log(`  no_bids depth:  ${ob.no_bids.length} levels`);
    console.log(`  best YES bid:   ${ob.best_yes_bid}`);
    console.log(`  best YES ask:   ${ob.best_yes_ask}  (= 1 - best_no_bid)`);
    console.log(`  best NO  bid:   ${ob.best_no_bid}`);
    console.log(`  best NO  ask:   ${ob.best_no_ask}  (= 1 - best_yes_bid)`);
    console.log(`  mid YES:        ${ob.mid_yes}`);
    console.log(`  spread:         ${ob.spread}`);
    // Sanity check: bids should sum to <= 1 (otherwise arb), asks sum to >= 1.
    if (ob.best_yes_bid !== null && ob.best_no_bid !== null) {
      const bidsSum = ob.best_yes_bid + ob.best_no_bid;
      const arbInBids = bidsSum > 1.0001; // tiny tolerance for rounding
      console.log(`  yes_bid + no_bid = ${bidsSum.toFixed(4)} ${arbInBids ? "← VIOLATES NO-ARB" : "✓"}`);
    }
  }

  console.log("\nsmoke test passed ✓");
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
