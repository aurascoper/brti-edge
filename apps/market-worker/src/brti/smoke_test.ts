// Smoke test for BrtiAggregator: starts the aggregator, waits 30 seconds,
// then prints the latest snapshots + σ estimates for BTC and ETH.
//
// Run: pnpm exec tsx src/brti/smoke_test.ts
//
// This is a one-shot validator. Expected output:
//   - "ticks received: ..." after 5s (3 venues × 2 symbols = 6 tick streams)
//   - "snapshot BTC: ..." after 15s (σ estimator warms after 60s of returns)
//   - σ should be in [0.3, 1.5] for BTC/ETH on a normal trading day

import { BrtiAggregator } from "./aggregator";

async function main() {
  const brti = new BrtiAggregator(["BTC", "ETH"]);
  console.log("[smoke] starting aggregator");
  await brti.start();

  for (let i = 1; i <= 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const btc = brti.getSnapshot("BTC");
    const eth = brti.getSnapshot("ETH");
    const sigmaBtc = brti.getSigmaAnnual("BTC");
    const sigmaEth = brti.getSigmaAnnual("ETH");
    const ofiBtc = brti.getOfi("BTC");
    console.log(
      `[smoke] t+${i * 5}s  ` +
        `BTC=$${btc?.price.toFixed(2) ?? "null"} σ=${sigmaBtc?.toFixed(3) ?? "null"} ` +
        `contributors=[${btc?.contributors.join(",") ?? ""}]  ` +
        `ETH=$${eth?.price.toFixed(2) ?? "null"} σ=${sigmaEth?.toFixed(3) ?? "null"}  ` +
        `OFI(BTC)=${ofiBtc?.top1_imbalance.toFixed(3) ?? "null"}`,
    );
  }

  await brti.stop();
  console.log("[smoke] done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
