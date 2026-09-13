import assert from "node:assert/strict";
import test from "node:test";
import { activeDemoSeries, checkEnvironment, collectPages, fixedPrice, requireManualCount, translate, validateV2, type Outcome, type Action } from "./cellular.js";

test("T-KAL-3 all 99 cents round trip for YES/NO buy/sell; legacy and maker fail", () => {
  for (let cent = 1; cent <= 99; cent++) for (const outcome of ["YES", "NO"] as Outcome[]) for (const action of ["buy", "sell"] as Action[]) {
    const order = translate({ticker: "KXBTC15M-FIXTURE", clientOrderId: "test", outcome, action, priceDollars: `0.${String(cent).padStart(2,"0")}`, quantity: "1", subaccount: 0});
    validateV2(order);
    const raw = fixedPrice(order.price);
    assert.equal(outcome === "YES" ? raw : 10000n-raw, BigInt(cent)*100n);
    assert.equal(order.side, (outcome === "YES") === (action === "buy") ? "bid" : "ask");
    assert.equal(order.reduce_only, action === "sell");
  }
  assert.throws(() => validateV2({ticker: "KXBTC15M-FIXTURE", side: "yes", action: "buy", count: 1, yes_price: 50}), /legacy/);
  const order = translate({ticker:"KXBTC15M-FIXTURE", clientOrderId:"x", outcome:"NO", action:"buy", priceDollars:"0.35", quantity:"1", subaccount:0});
  assert.throws(() => validateV2({...order, post_only:true}), /taker_policy/);
  assert.throws(() => fixedPrice("35"), /invalid_fixed_price/);
});

test("T-KAL-1 query filter cannot make a closed market active", () => {
  const series = {ticker:"KXBTC15M",frequency:"fifteen_min"};
  const row = {ticker:"KXBTC15M-TEST", status:"active", open_time:"2026-09-13T06:45:00Z", close_time:"2026-09-13T07:00:00Z"};
  const now = Date.parse("2026-09-13T06:54:00Z");
  assert.equal(activeDemoSeries(series, [row], now), true);
  assert.equal(activeDemoSeries(series, [{...row,status:"closed"}], now), false);
  assert.equal(activeDemoSeries(series, [row], Date.parse(row.close_time)), false);
});

test("T-KAL-2 worker and cross-environment credentials refused", () => {
  checkEnvironment({CELLULAR_PROCESS_ROLE:"executor"}, "PAPER");
  assert.throws(() => checkEnvironment({CELLULAR_PROCESS_ROLE:"arena"},"DEMO"), /executor_role/);
  assert.throws(() => checkEnvironment({CELLULAR_PROCESS_ROLE:"executor",KALSHI_API_KEY_ID:"dummy"},"DEMO"), /unscoped/);
  assert.throws(() => checkEnvironment({CELLULAR_PROCESS_ROLE:"executor",KALSHI_PROD_KEY:"dummy",KALSHI_DEMO_KEY:"dummy"},"DEMO"), /credentials/);
});

test("T-KAL-4 zero manual confirmations refused for an untested series", () => {
  requireManualCount(true,3);
  assert.throws(() => requireManualCount(true,0), /manual_confirmation_required/);
});

test("full pagination required, duplicate pages and missing cursor refused", async () => {
  const rows = await collectPages<{id:string}>(async cursor => cursor ? {orders:[{id:"b"}],cursor:""} : {orders:[{id:"a"}],cursor:"next"},"orders",r=>r.id);
  assert.equal(rows.length,2);
  await assert.rejects(collectPages(async () => ({orders:[],cursor:"loop"}),"orders",()=>""), /pagination_cycle/);
  await assert.rejects(collectPages(async () => ({orders:[]}),"orders",()=>""), /incomplete_page/);
  await assert.rejects(collectPages<{id:string}>(async () => ({orders:[{id:"a"}],cursor:"next"}),"orders",r=>r.id), /duplicate_or_missing/);
});
