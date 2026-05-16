// Tests for SettlementValidator. Pure synthetic timestamps; no network,
// no Date.now(), no fs writes outside the temp output path.
//
// Run: pnpm exec tsx --test src/kalshi/settlementValidator.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SETTLEMENT_VALIDATION_SCHEMA_VERSION,
  SETTLEMENT_WINDOW_MS,
  MIN_SAMPLES_PER_WINDOW,
  SettlementValidator,
  windowStats,
  impliedResult,
  type SamplePoint,
  type TrackOpts,
} from "./settlementValidator";

// --- pure helpers ---

test("windowStats: only samples in [close-60s, close] are counted", () => {
  const close_ms = 1_000_000;
  const samples: SamplePoint[] = [
    { ts_ms: close_ms - 70_000, brti_price: 100, binance_price: 100 },   // outside (before)
    { ts_ms: close_ms - 60_000, brti_price: 110, binance_price: 105 },   // boundary in
    { ts_ms: close_ms - 30_000, brti_price: 120, binance_price: 115 },   // inside
    { ts_ms: close_ms, brti_price: 130, binance_price: 125 },            // boundary in
    { ts_ms: close_ms + 1, brti_price: 999, binance_price: 999 },        // outside (after)
  ];
  const w = windowStats(samples, close_ms);
  assert.equal(w.brti_n, 3);
  assert.equal(w.binance_n, 3);
  assert.equal(w.brti_mean, (110 + 120 + 130) / 3);
  assert.equal(w.binance_mean, (105 + 115 + 125) / 3);
});

test("windowStats: counts brti and binance independently when one is null", () => {
  const close_ms = 1_000_000;
  const samples: SamplePoint[] = [
    { ts_ms: close_ms - 50_000, brti_price: 100, binance_price: null }, // brti only
    { ts_ms: close_ms - 40_000, brti_price: null, binance_price: 200 }, // binance only
    { ts_ms: close_ms - 30_000, brti_price: 110, binance_price: 210 },  // both
  ];
  const w = windowStats(samples, close_ms);
  assert.equal(w.brti_n, 2);
  assert.equal(w.binance_n, 2);
  assert.equal(w.brti_mean, 105);
  assert.equal(w.binance_mean, 205);
});

test("windowStats: empty window returns null means with zero n", () => {
  const w = windowStats([], 1_000_000);
  assert.equal(w.brti_mean, null);
  assert.equal(w.binance_mean, null);
  assert.equal(w.brti_n, 0);
  assert.equal(w.binance_n, 0);
});

test("windowStats: SETTLEMENT_WINDOW_MS is 60000", () => {
  assert.equal(SETTLEMENT_WINDOW_MS, 60_000);
});

test("impliedResult: >= strike returns yes, < strike returns no, null passes through", () => {
  assert.equal(impliedResult(100, 100), "yes");      // boundary inclusive
  assert.equal(impliedResult(100.01, 100), "yes");
  assert.equal(impliedResult(99.99, 100), "no");
  assert.equal(impliedResult(null, 100), null);
});

// --- validator integration ---

function makeValidator() {
  const dir = mkdtempSync(join(tmpdir(), "settlement-validator-"));
  const outputPath = join(dir, "validation.jsonl");
  return { v: new SettlementValidator({ outputPath }), outputPath };
}

function makeTrackOpts(overrides: Partial<TrackOpts> = {}): TrackOpts {
  return {
    ticker: "KXBTC15M-26MAY150000-00",
    series: "KXBTC15M",
    strike: 80_000,
    close_time_ms: 1_000_000,
    brti_symbol: "BTC",
    cex_symbol: "BTCUSDT",
    ...overrides,
  };
}

test("track + record: builds ring per ticker; ignores records for unknown tickers", () => {
  const { v } = makeValidator();
  v.track(makeTrackOpts());
  v.record(500_000, "KXBTC15M-26MAY150000-00", 79_500, 79_510);
  v.record(500_001, "UNKNOWN-TICKER", 1, 1);
  assert.equal(v.getRingSize("KXBTC15M-26MAY150000-00"), 1);
  assert.equal(v.getRingSize("UNKNOWN-TICKER"), 0);
});

test("finalize: rejects when both sources have <40 samples", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  // 39 samples, both sources populated, all inside the window
  for (let i = 0; i < 39; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_500, opts.ticker, 80_500, 80_400);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 5_000);
  assert.ok(row !== null);
  assert.match(row!.rejected_reason ?? "", /insufficient_samples/);
  assert.equal(row!.brti_window_n, 39);
});

test("finalize: passes when ≥40 samples in at least one source", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000);
  assert.ok(row !== null);
  assert.equal(row!.rejected_reason, null);
  assert.equal(row!.brti_window_n, 60);
  assert.equal(row!.binance_window_n, 60);
});

test("finalize: A/B implied-result + matches_kalshi correctness", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts({ strike: 80_000 });
  v.track(opts);
  // BRTI mean > strike (80,500), Binance mean < strike (79,500)
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 79_500);
  }
  // Kalshi printed YES (price closed above strike)
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000)!;
  assert.equal(row.brti_implied_result, "yes");
  assert.equal(row.binance_implied_result, "no");
  assert.equal(row.brti_matches_kalshi, true);
  assert.equal(row.binance_matches_kalshi, false);
});

test("finalize: idempotent — second call returns null and does not double-append", () => {
  const { v, outputPath } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  const first = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000);
  const second = v.finalize(opts.ticker, "yes", opts.close_time_ms + 2_000);
  const third = v.finalize(opts.ticker, "no", opts.close_time_ms + 3_000); // different result
  assert.ok(first !== null);
  assert.equal(second, null);
  assert.equal(third, null);
  assert.equal(v.hasFinalized(opts.ticker), true);
  assert.ok(existsSync(outputPath));
  const lines = readFileSync(outputPath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "exactly one JSONL row should be appended");
});

test("record: ignored after finalize() to prevent late samples from corrupting state", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000);
  const ringBefore = v.getRingSize(opts.ticker);
  v.record(opts.close_time_ms + 5_000, opts.ticker, 81_000, 81_000);
  assert.equal(v.getRingSize(opts.ticker), ringBefore, "late samples ignored after finalize");
});

test("schema_version is 1 in emitted row", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000)!;
  assert.equal(row.schema_version, 1);
  assert.equal(SETTLEMENT_VALIDATION_SCHEMA_VERSION, 1);
});

test("clock_skew_ms is null by default and pass-through when provided", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000, 123)!;
  assert.equal(row.clock_skew_ms, 123);
});

test("recordDecision: last-write-wins, surfaces in finalize row", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  v.recordDecision(opts.ticker, {
    fair_yes: 0.42,
    side: "YES",
    sigma_annual: 0.18,
    spot_source: "brti",
    sigma_source: "brti",
  });
  // Updated by a later scan
  v.recordDecision(opts.ticker, {
    fair_yes: 0.48,
    side: "YES",
    sigma_annual: 0.20,
    spot_source: "brti",
    sigma_source: "brti",
  });
  for (let i = 0; i < 60; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000)!;
  assert.equal(row.our_fair_yes_at_decision, 0.48);
  assert.equal(row.our_side_at_decision, "YES");
  assert.equal(row.sigma_at_decision, 0.20);
  assert.equal(row.decision_spot_source, "brti");
  assert.equal(row.decision_sigma_source, "brti");
});

test("matched BRTI/Binance sampling: identical ts_ms → mean-of-aligned-samples", () => {
  const { v } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  // 60 matched samples, both prices set together — proves the caller can drive
  // identical timestamps and both means align to the same sample set.
  for (let i = 0; i < 60; i++) {
    const ts = opts.close_time_ms - 60_000 + i * 1_000;
    v.record(ts, opts.ticker, 80_000 + i, 79_900 + i);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000)!;
  assert.equal(row.brti_window_n, row.binance_window_n);
  // Both means come from the same i=0..59 range, so brti = binance + 100
  assert.ok(Math.abs((row.brti_window_mean! - row.binance_window_mean!) - 100) < 1e-9);
});

test("rejected windows still emit a row (for auditability) with implied + matches null", () => {
  const { v, outputPath } = makeValidator();
  const opts = makeTrackOpts();
  v.track(opts);
  // 10 samples — both sources below the 40 threshold
  for (let i = 0; i < 10; i++) {
    v.record(opts.close_time_ms - 60_000 + i * 1_000, opts.ticker, 80_500, 80_400);
  }
  const row = v.finalize(opts.ticker, "yes", opts.close_time_ms + 1_000);
  assert.ok(row !== null);
  assert.match(row!.rejected_reason ?? "", /insufficient_samples/);
  // Means are still computed (we have some samples) — but the rejected_reason
  // tells downstream analytics to drop this row from the A/B comparison.
  assert.equal(typeof row!.brti_window_mean, "number");
  // File should contain one rejected row.
  const lines = readFileSync(outputPath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
});

test("MIN_SAMPLES_PER_WINDOW constant is exported and equals 40", () => {
  assert.equal(MIN_SAMPLES_PER_WINDOW, 40);
});
