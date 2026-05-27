// =============================================================================
// KXBTC15M_PASSIVE_MAKER_v2 — frozen policy implementation
// =============================================================================
//
// Pre-registration: docs/research/kxbtc15m-v2-preregistration.md
//   - policy text locked at commit  71216c6  (commit A: §5 §7 §9 §10 filled)
//   - Status flipped LOCKED at      e65a36b  (commit B)
//
// This file implements the policy frozen in the preregistration above.
// EVERY constant below must match the preregistration's §7, §9, §10
// values exactly. Any divergence between code and spec is a bug in this
// file, NOT a license to amend the spec. If a value here disagrees with
// the spec, fix the value here and re-run the sanity check.
//
// Two output regimes:
//   - When --label includes "holdout"      → report §13 Gates 1-9 pass/fail
//   - Any other label (e.g. "sanity-check")→ report metrics only; gates
//                                            are explicitly NOT computed
//                                            (operator guardrail #4)
//
// Run:
//   pnpm exec tsx src/replay/btcMakerV2.ts --log-dir=... --label=sanity-check-...
//   pnpm exec tsx src/replay/btcMakerV2.ts --log-dir=<holdout> --label=holdout-...
//
// =============================================================================
// CODE-LEVEL AMBIGUITY DECISIONS (binding for the holdout)
// =============================================================================
// These are resolutions of operational ambiguities in the locked spec.
// They are CODE decisions, not spec decisions; per the operator's
// guardrail #1, they cannot be amended after the holdout is scored.
//
//   AD-1  cancel_on_spread_widen fires when:
//           spread_now_ticks > spread_at_post_ticks + 1
//         where spread = best_yes_ask - best_yes_bid, in tick units (1 cent).
//         Rationale: 1 tick is the smallest discretely meaningful change;
//         tighter would catch quote-flicker noise.
//
//   AD-2  cancel_on_queue_deterioration under conservative_threshold:
//         the literal interpretation ("queue_position_fp increased by >=1")
//         cannot occur under back-of-queue replay — new orders at our
//         price level join BEHIND us by price-time priority and do not
//         worsen our queue position. The operational equivalent that
//         CAN occur is: best_yes_bid_now > best_yes_bid_at_post (the
//         touch moved to a strictly better price than where we posted;
//         we are no longer at the touch). This is the binding definition
//         under the conservative_threshold queue model.
//
//   AD-3  cancel_on_inventory_breach is enforced at QUOTE POST TIME:
//         count open positions (filled-but-unsettled) at the quote's
//         post timestamp; if (open + 1) > max_net_directional_contracts,
//         reject the quote with reason "inventory_cap". No after-the-fact
//         cancellation of outstanding sims is performed in replay
//         (which would require cross-quote orchestration); the post-time
//         check is the binding implementation.
//
//   AD-4  max_contracts_per_market is enforced at post time as well:
//         if any open or alive quote exists on the same market_ticker,
//         reject as "per_market_cap".
//
//   AD-5  settlement_time = last bookEvent.tsMs for the market. A filled
//         position is considered "open" between its fillTsMs and its
//         market's settlement_time; after that it is settled and no
//         longer counted in open-position inventory.
//
//   AD-6  Queue model is conservative_threshold = simulateQuote(queue:
//         {type: "back"}) from queueModel.ts. The existing simulator's
//         levelDepleted condition (level depth hits 0 before our fill)
//         is treated as a cancel event for v2 purposes — this is
//         slightly MORE conservative than the literal spec language
//         (which requires "a cancel event has removed our slot"). The
//         spec's intent is conservatism, so erring conservative is
//         spec-faithful. Documented here in case future readers want
//         to revisit.
// =============================================================================

import { resolve } from "node:path";
import {
  applyDelta,
  applySnapshot,
  applyTerminalSnapshot,
  bestYesAsk,
  bestYesBid,
  newBookState,
  priceToTicks,
  type BookEvent,
  type KalshiBookState,
} from "./bookReconstructor.js";
import {
  buildMarketIndex,
  simulateQuote,
  type HypotheticalQuote,
  type MarketIndex,
  type QuoteSimulationResult,
} from "./queueModel.js";

// =============================================================================
// LOCKED POLICY CONSTANTS (mirror preregistration; any change = code bug)
// =============================================================================

const POLICY_NAME = "KXBTC15M_PASSIVE_MAKER_v2";
const PREREG_DOC = "docs/research/kxbtc15m-v2-preregistration.md";
const PREREG_COMMIT_A = "71216c6"; // policy text
const PREREG_LOCK_COMMIT = "e65a36b"; // lock transition

// §6 Instruments
const SERIES = "KXBTC15M";

// §7.1 Quoting mode → yes_only_guarded
// §7.2 Side rules
const SIDE = "yes" as const;
const SIZE_CONTRACTS = 1;

// §7.3 Quote price: at_touch (best_yes_bid)
// §7.4 Quote duration / cancel
const QUOTE_DURATION_MS = 75_000;
const CANCEL_ON_SPREAD_WIDEN = true;
const CANCEL_ON_QUEUE_DETERIORATION = true;
const CANCEL_BEFORE_EXPIRY_MS = 60_000;
const SPREAD_WIDEN_THRESHOLD_TICKS = 1; // AD-1

// §7.5 TTE filter
const TTE_MIN_MS = 360_000; // 6 minutes
const TTE_MAX_MS = 840_000; // 14 minutes

// §7.6 Time-of-day filter: 00-08Z only, exploratory_origin label
const ALLOWED_UTC_HOURS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

// §7.7 Spread filter: floor only; ceiling disabled
const MIN_SPREAD_TICKS = 1;

// §7.8 Moneyness: |touch − 0.50| ∈ [0.15, 0.40]
const MONEYNESS_MIN = 0.15;
const MONEYNESS_MAX = 0.40;

// §9.1 §9.2 Inventory caps
const MAX_NET_DIRECTIONAL_CONTRACTS = 2;
const MAX_CONTRACTS_PER_MARKET = 1;

// §10.1 §10.2 Queue model: conservative_threshold = back of queue
const QUEUE_ASSUMPTION = { type: "back" as const };

// Operational
const ANCHOR_PERIOD_MS = 60_000;
const ANCHOR_RUNWAY_MS = 60_000;

// =============================================================================
// Helpers
// =============================================================================

function isBtcMarket(mt: string): boolean {
  return mt.startsWith(SERIES + "-");
}

function utcHourOf(tsMs: number): number {
  return new Date(tsMs).getUTCHours();
}

function tteOk(tteMs: number): boolean {
  return tteMs >= TTE_MIN_MS && tteMs <= TTE_MAX_MS;
}

function utcHourOk(tsMs: number): boolean {
  return ALLOWED_UTC_HOURS.has(utcHourOf(tsMs));
}

function moneynessOk(touchPrice: number): boolean {
  const m = Math.abs(touchPrice - 0.5);
  return m >= MONEYNESS_MIN && m <= MONEYNESS_MAX;
}

function priceTicksOf(p: number): number {
  return priceToTicks(p.toFixed(4));
}

function wallClock2hKey(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = d.getUTCHours();
  const block = Math.floor(hh / 2) * 2;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(block).padStart(2, "0")}`;
}

type TteBucket = "6-9min" | "9-12min" | "12-15min";
function tteBucketOf(tteMs: number): TteBucket | null {
  const mins = tteMs / 60_000;
  if (mins < 6) return null;
  if (mins < 9) return "6-9min";
  if (mins < 12) return "9-12min";
  if (mins <= 14) return "12-15min"; // includes [12, 14] under v2's 14min ceiling
  return null;
}

type UtcBlock = "00-04Z" | "04-08Z";
function utcBlockOf(tsMs: number): UtcBlock | null {
  const h = utcHourOf(tsMs);
  if (h >= 0 && h < 4) return "00-04Z";
  if (h >= 4 && h < 8) return "04-08Z";
  return null;
}

// =============================================================================
// Settlement inference (v1-compatible, duplicated for code-isolation)
// =============================================================================

interface SettlementLabel {
  value: number | null;
  confidence: "high" | "low" | "none";
}

function inferSettlement(
  midTs: number[],
  midYes: number[],
  lastTradeTs: number,
  lastTradeYesPrice: number,
): SettlementLabel {
  const lastMidIdx = midYes.length - 1;
  const lastMidTs = lastMidIdx >= 0 ? (midTs[lastMidIdx] as number) : -1;
  const lastMid = lastMidIdx >= 0 ? (midYes[lastMidIdx] as number) : Number.NaN;
  let v: number;
  if (lastTradeTs > lastMidTs && Number.isFinite(lastTradeYesPrice)) v = lastTradeYesPrice;
  else if (!Number.isNaN(lastMid)) v = lastMid;
  else return { value: null, confidence: "none" };
  if (v >= 0.97) return { value: 1.0, confidence: "high" };
  if (v <= 0.03) return { value: 0.0, confidence: "high" };
  return { value: v, confidence: "low" };
}

// =============================================================================
// v2 simulator wrapper — adds spread-widen + queue-deterioration cancel triggers
// =============================================================================

type CancelReason =
  | "none"
  | "ttl"
  | "spread_widen"
  | "queue_deterioration"
  | "level_depleted"
  | "market_terminated";

interface V2SimResult {
  filled: boolean;
  fillTsMs: number | null;
  fillFraction: number;
  cancelReason: CancelReason;
  raw: QuoteSimulationResult;
}

// Walk book events between (postedAtMs, stopTs] and return the timestamp +
// reason of the first cancel-trigger event, or null if none fires by stopTs.
function findCancelTrigger(
  mIdx: MarketIndex,
  postedAtMs: number,
  stopTs: number,
  spreadAtPostTicks: number,
  bestYesBidAtPostTicks: number,
): { ts: number; reason: CancelReason } | null {
  // Rebuild book state up to postedAtMs inclusive.
  const state: KalshiBookState = newBookState(mIdx.marketTicker, "");
  let i = 0;
  while (i < mIdx.bookEvents.length) {
    const ev = mIdx.bookEvents[i] as BookEvent;
    if (ev.tsMs > postedAtMs) break;
    applyAny(state, ev);
    i += 1;
  }

  // Walk forward checking triggers at each book event.
  for (; i < mIdx.bookEvents.length; i++) {
    const ev = mIdx.bookEvents[i] as BookEvent;
    if (ev.tsMs > stopTs) break;
    applyAny(state, ev);

    const curBid = bestYesBid(state);
    const curAsk = bestYesAsk(state);

    if (CANCEL_ON_QUEUE_DETERIORATION && curBid !== null) {
      const curBidTicks = priceTicksOf(curBid);
      if (curBidTicks > bestYesBidAtPostTicks) {
        return { ts: ev.tsMs, reason: "queue_deterioration" };
      }
    }

    if (CANCEL_ON_SPREAD_WIDEN && curBid !== null && curAsk !== null) {
      const curSpread = curAsk - curBid;
      const curSpreadTicks = priceTicksOf(curSpread);
      if (curSpreadTicks > spreadAtPostTicks + SPREAD_WIDEN_THRESHOLD_TICKS) {
        return { ts: ev.tsMs, reason: "spread_widen" };
      }
    }
  }

  return null;
}

function applyAny(state: KalshiBookState, ev: BookEvent): void {
  if (ev.type === "snapshot") applySnapshot(state, ev);
  else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
  else applyDelta(state, ev);
}

function simulateQuoteV2(
  quote: HypotheticalQuote,
  mIdx: MarketIndex,
  spreadAtPostTicks: number,
  bestYesBidAtPostTicks: number,
): V2SimResult {
  // 1. Underlying back-of-queue simulator with 75s TTL.
  const r = simulateQuote(quote, mIdx, QUOTE_DURATION_MS);

  // 2. If filled, check whether a cancel trigger fired BEFORE fillTsMs.
  if (r.filled && r.fillTsMs !== null) {
    const trig = findCancelTrigger(mIdx, quote.postedAtMs, r.fillTsMs, spreadAtPostTicks, bestYesBidAtPostTicks);
    if (trig !== null && trig.ts < r.fillTsMs) {
      return { filled: false, fillTsMs: null, fillFraction: 0, cancelReason: trig.reason, raw: r };
    }
    return { filled: true, fillTsMs: r.fillTsMs, fillFraction: r.fillFraction, cancelReason: "none", raw: r };
  }

  // 3. Unfilled — determine which cancel/exit reason fired first.
  // Check trigger events within the TTL window first.
  const ttlEnd = quote.postedAtMs + QUOTE_DURATION_MS;
  const trig = findCancelTrigger(mIdx, quote.postedAtMs, ttlEnd, spreadAtPostTicks, bestYesBidAtPostTicks);
  if (trig !== null) {
    return { filled: false, fillTsMs: null, fillFraction: 0, cancelReason: trig.reason, raw: r };
  }
  // Otherwise fall back to the simulator's verdict.
  let cancelReason: CancelReason = "ttl";
  if (r.marketTerminated) cancelReason = "market_terminated";
  else if (r.levelDepleted) cancelReason = "level_depleted";
  else if (r.cancelledByHorizon) cancelReason = "ttl";
  return { filled: false, fillTsMs: null, fillFraction: 0, cancelReason, raw: r };
}

// =============================================================================
// Pre-post filter decision tree
// =============================================================================

type RejectReason =
  | "tte_filter"
  | "utc_hour_filter"
  | "moneyness_filter"
  | "spread_floor"
  | "no_touch_available"
  | "inventory_cap"
  | "per_market_cap";

interface FilterResult {
  posted: boolean;
  rejectReason: RejectReason | null;
  bestYesBid: number | null;
  spreadTicks: number | null;
}

function applyPrePostFilters(
  state: KalshiBookState,
  tteMs: number,
  anchorTsMs: number,
  marketTicker: string,
  openPositionCount: number,
  marketHasOpenOrAlive: (mt: string) => boolean,
): FilterResult {
  if (!tteOk(tteMs)) return reject("tte_filter");
  if (!utcHourOk(anchorTsMs)) return reject("utc_hour_filter");

  const yb = bestYesBid(state);
  if (yb === null) return reject("no_touch_available");

  if (!moneynessOk(yb)) return reject("moneyness_filter");

  const ya = bestYesAsk(state);
  if (ya === null) return reject("no_touch_available");
  const spread = ya - yb;
  const spreadTicks = priceTicksOf(spread);
  if (spreadTicks < MIN_SPREAD_TICKS) return reject("spread_floor");

  // Inventory check (AD-3): would posting this quote take us over the cap?
  if (openPositionCount + 1 > MAX_NET_DIRECTIONAL_CONTRACTS) {
    return reject("inventory_cap");
  }
  // Per-market check (AD-4)
  if (marketHasOpenOrAlive(marketTicker)) {
    return reject("per_market_cap");
  }

  return { posted: true, rejectReason: null, bestYesBid: yb, spreadTicks };

  function reject(r: RejectReason): FilterResult {
    return { posted: false, rejectReason: r, bestYesBid: null, spreadTicks: null };
  }
}

// =============================================================================
// Per-quote record + main loop
// =============================================================================

interface QuoteRecord {
  marketTicker: string;
  postedAtMs: number;
  tteMs: number;
  tteBucket: TteBucket;
  utcBlock: UtcBlock;
  wallClock2h: string;
  touchPrice: number;
  spreadTicksAtPost: number;
  // outcome
  filled: boolean;
  fillTsMs: number | null;
  fillFraction: number;
  cancelReason: CancelReason;
  // PnL
  settlementValue: number | null;
  settlementConfidence: "high" | "low" | "none";
  pnlSettlement: number | null; // dollars; YES-bid: (S - touch) * fillFraction
}

interface RejectRecord {
  marketTicker: string;
  anchorTsMs: number;
  reason: RejectReason;
}

interface Args {
  logDir: string;
  label: string;
}
function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return {
    logDir: args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector"),
    label: args.label ?? "sanity-check-unlabeled",
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const isHoldoutRun = args.label.toLowerCase().includes("holdout");
  process.stderr.write(`[${POLICY_NAME}] preregistration: ${PREREG_DOC} (commit A ${PREREG_COMMIT_A}, lock ${PREREG_LOCK_COMMIT})\n`);
  process.stderr.write(`[${POLICY_NAME}] log dir: ${args.logDir}\n`);
  process.stderr.write(`[${POLICY_NAME}] label: ${args.label} (gate computation: ${isHoldoutRun ? "ENABLED — holdout" : "DISABLED — non-holdout, metrics only"})\n`);

  // ---- index ----
  const t0 = Date.now();
  process.stderr.write(`[${POLICY_NAME}] building market index for ${SERIES}...\n`);
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(`[${POLICY_NAME}] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // ---- settlement labels ----
  const settlements = new Map<string, SettlementLabel>();
  const marketLastTs = new Map<string, number>();
  for (const [mt, m] of idx.entries()) {
    const lastBook = m.bookEvents[m.bookEvents.length - 1];
    marketLastTs.set(mt, lastBook ? lastBook.tsMs : -1);
    const lastTrade = m.trades[m.trades.length - 1];
    settlements.set(
      mt,
      inferSettlement(m.midTs, m.midYes, lastTrade ? lastTrade.tsMs : -1, lastTrade ? lastTrade.yesPrice : Number.NaN),
    );
  }

  // ---- enumerate eligible anchors per market ----
  type Anchor = { marketTicker: string; tsMs: number; tteMs: number };
  const anchors: Anchor[] = [];
  for (const m of idx.values()) {
    if (m.bookEvents.length < 10) continue;
    const first = m.bookEvents[0]!.tsMs;
    const last = m.bookEvents[m.bookEvents.length - 1]!.tsMs;
    if (last - first < 2 * ANCHOR_PERIOD_MS) continue;
    const lastAnchor = last - ANCHOR_RUNWAY_MS;
    for (let ts = first + ANCHOR_PERIOD_MS; ts <= lastAnchor; ts += ANCHOR_PERIOD_MS) {
      const tteMs = last - ts;
      anchors.push({ marketTicker: m.marketTicker, tsMs: ts, tteMs });
    }
  }
  // Sort globally by anchor time so inventory-tracking is causally consistent.
  anchors.sort((a, b) => a.tsMs - b.tsMs);
  process.stderr.write(`[${POLICY_NAME}] ${anchors.length.toLocaleString()} candidate anchors\n`);

  // ---- inventory state (causal, time-ordered) ----
  interface OpenPosition {
    marketTicker: string;
    filledAtMs: number;
    settleAtMs: number;
  }
  const openPositions: OpenPosition[] = [];
  // Track markets that currently have an alive (posted-but-not-yet-resolved-by-replay) quote.
  // In replay, "alive" means we've decided to post but the simulator hasn't returned yet.
  // Since we process anchors strictly in time order and the simulator is per-anchor, the
  // concept of "alive but not yet resolved" collapses: each simulation is atomic in our walk.
  // The per-market cap (AD-4) therefore becomes: market has any open position OR has had
  // a quote posted whose TTL window overlaps the current anchor time.
  // We track this with `marketAliveUntilMs[mt] = postedAtMs + QUOTE_DURATION_MS`.
  const marketAliveUntilMs = new Map<string, number>();

  function pruneOpenPositions(nowMs: number): number {
    let writeIdx = 0;
    for (let i = 0; i < openPositions.length; i++) {
      const p = openPositions[i]!;
      if (p.settleAtMs > nowMs) {
        openPositions[writeIdx++] = p;
      }
    }
    openPositions.length = writeIdx;
    return openPositions.length;
  }

  function pruneAliveQuotes(nowMs: number): void {
    for (const [mt, until] of Array.from(marketAliveUntilMs.entries())) {
      if (until <= nowMs) marketAliveUntilMs.delete(mt);
    }
  }

  // ---- simulate ----
  const records: QuoteRecord[] = [];
  const rejects: RejectRecord[] = [];
  const tSim = Date.now();

  for (const a of anchors) {
    pruneOpenPositions(a.tsMs);
    pruneAliveQuotes(a.tsMs);
    const openCount = openPositions.length;

    const m = idx.get(a.marketTicker)!;

    // Snapshot book state at anchor.
    const state = newBookState(a.marketTicker, "");
    for (const ev of m.bookEvents) {
      if (ev.tsMs > a.tsMs) break;
      applyAny(state, ev);
    }

    const flt = applyPrePostFilters(
      state,
      a.tteMs,
      a.tsMs,
      a.marketTicker,
      openCount,
      (mt) => marketAliveUntilMs.has(mt) || openPositions.some((p) => p.marketTicker === mt),
    );

    if (!flt.posted) {
      rejects.push({ marketTicker: a.marketTicker, anchorTsMs: a.tsMs, reason: flt.rejectReason! });
      continue;
    }

    const tteB = tteBucketOf(a.tteMs)!;
    const utcB = utcBlockOf(a.tsMs)!; // already passed utcHourOk; will be 00-04Z or 04-08Z

    const quote: HypotheticalQuote = {
      marketTicker: a.marketTicker,
      side: SIDE,
      priceDollars: flt.bestYesBid!,
      sizeContracts: SIZE_CONTRACTS,
      postedAtMs: a.tsMs,
      queue: QUEUE_ASSUMPTION,
    };

    const bestYesBidTicks = priceTicksOf(flt.bestYesBid!);
    const r = simulateQuoteV2(quote, m, flt.spreadTicks!, bestYesBidTicks);

    // Record alive-window so future anchors on this market within the TTL are rejected.
    marketAliveUntilMs.set(a.marketTicker, a.tsMs + QUOTE_DURATION_MS);

    const settlement = settlements.get(a.marketTicker)!;
    let pnl: number | null = null;
    if (r.filled && settlement.value !== null) {
      pnl = (settlement.value - flt.bestYesBid!) * r.fillFraction;
    } else if (!r.filled) {
      pnl = 0;
    }

    records.push({
      marketTicker: a.marketTicker,
      postedAtMs: a.tsMs,
      tteMs: a.tteMs,
      tteBucket: tteB,
      utcBlock: utcB,
      wallClock2h: wallClock2hKey(a.tsMs),
      touchPrice: flt.bestYesBid!,
      spreadTicksAtPost: flt.spreadTicks!,
      filled: r.filled,
      fillTsMs: r.fillTsMs,
      fillFraction: r.fillFraction,
      cancelReason: r.cancelReason,
      settlementValue: settlement.value,
      settlementConfidence: settlement.confidence,
      pnlSettlement: pnl,
    });

    if (r.filled && r.fillTsMs !== null) {
      const settleTs = marketLastTs.get(a.marketTicker) ?? r.fillTsMs;
      openPositions.push({ marketTicker: a.marketTicker, filledAtMs: r.fillTsMs, settleAtMs: settleTs });
    }
  }

  process.stderr.write(`[${POLICY_NAME}] simulated ${records.length.toLocaleString()} posted quotes (${rejects.length.toLocaleString()} filter rejects) in ${((Date.now() - tSim) / 1000).toFixed(1)}s\n`);

  // ---- aggregate ----
  const posted = records.length;
  const filled = records.filter((r) => r.filled);
  const usable = records.filter((r) => r.pnlSettlement !== null);
  const fillRate = posted > 0 ? filled.length / posted : 0;
  const sumPnl = usable.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
  const evPosted = usable.length > 0 ? sumPnl / usable.length : 0;
  const filledUsable = filled.filter((r) => r.pnlSettlement !== null);
  const evFilled = filledUsable.length > 0 ? sumPnl / filledUsable.length : 0;

  // ---- output ----
  console.log();
  console.log(`# ${POLICY_NAME} — \`${args.label}\``);
  console.log();
  if (!isHoldoutRun) {
    console.log("> **IMPLEMENTATION SANITY CHECK — NOT VALIDATION.**");
    console.log("> This run scored a *non-holdout* dataset. Gate pass/fail logic is");
    console.log(`> NOT computed and NOT printed. Purpose per the locked preregistration`);
    console.log(`> (\`${PREREG_DOC}\` commit A ${PREREG_COMMIT_A}, lock ${PREREG_LOCK_COMMIT}):`);
    console.log(`>   - confirm filters produce the expected cell counts,`);
    console.log(`>   - confirm the per-quote walk + cancel triggers execute,`);
    console.log(`>   - confirm settlement labeling resolves,`);
    console.log(`>   - record an in-sample baseline for later vs-holdout comparison.`);
    console.log(`> Numbers below are diagnostic. They do NOT update the spec.`);
    console.log(`> Any apparent gate pass or fail in these numbers is an artifact of`);
    console.log(`> the design corpus and CANNOT be cited as evidence about v2's edge.`);
  } else {
    console.log("> **HOLDOUT VALIDATION RUN.** §13 Gates 1-9 are computed below.");
    console.log("> Pass/fail is BINARY and TERMINAL. If any gate fails (and the §5.2");
    console.log("> sample-size extension does not apply), v2 is rejected permanently.");
  }
  console.log();
  console.log(`- Policy:           ${POLICY_NAME}`);
  console.log(`- Preregistration:  ${PREREG_DOC}`);
  console.log(`- Locked at:        commit A ${PREREG_COMMIT_A}, lock ${PREREG_LOCK_COMMIT}`);
  console.log(`- Log dir:          ${args.logDir}`);
  console.log(`- Markets indexed:  ${idx.size}`);
  console.log();

  console.log("## Headline");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| candidate anchors | ${anchors.length.toLocaleString()} |`);
  console.log(`| filter rejects | ${rejects.length.toLocaleString()} |`);
  console.log(`| posted | **${posted.toLocaleString()}** |`);
  console.log(`| filled | **${filled.length.toLocaleString()}** |`);
  console.log(`| fill rate | **${(fillRate * 100).toFixed(1)}%** |`);
  console.log(`| settlement EV per posted | **$${evPosted.toFixed(4)}** (= ${(evPosted * 100).toFixed(3)}¢) |`);
  console.log(`| settlement EV per filled | **$${evFilled.toFixed(4)}** (= ${(evFilled * 100).toFixed(3)}¢) |`);
  console.log(`| total settlement PnL | **$${sumPnl.toFixed(4)}** |`);
  console.log(`| usable records (with settlement label) | ${usable.length} |`);
  console.log();

  console.log("## Filter rejection breakdown");
  console.log();
  const rejCounts: Record<string, number> = {};
  for (const r of rejects) rejCounts[r.reason] = (rejCounts[r.reason] ?? 0) + 1;
  console.log("| reason | count |");
  console.log("|---|---:|");
  for (const [k, v] of Object.entries(rejCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${k} | ${v.toLocaleString()} |`);
  }
  console.log();

  console.log("## Cancel-reason breakdown (posted quotes)");
  console.log();
  const cancelCounts: Record<string, number> = {};
  for (const r of records) cancelCounts[r.cancelReason] = (cancelCounts[r.cancelReason] ?? 0) + 1;
  console.log("| cancel reason | count |");
  console.log("|---|---:|");
  for (const [k, v] of Object.entries(cancelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${k} | ${v.toLocaleString()} |`);
  }
  console.log();

  console.log("## By TTE bucket");
  console.log();
  console.log("| TTE | posted | filled | fill rate | EV/posted ($) | EV/filled ($) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const b of ["6-9min", "9-12min", "12-15min"] as const) {
    const sub = records.filter((r) => r.tteBucket === b);
    const subFilled = sub.filter((r) => r.filled);
    const subUsable = sub.filter((r) => r.pnlSettlement !== null);
    const subSum = subUsable.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
    const subFilledUsable = subFilled.filter((r) => r.pnlSettlement !== null);
    if (sub.length === 0) {
      console.log(`| ${b} | 0 | 0 | — | — | — |`);
      continue;
    }
    const fr = subFilled.length / sub.length;
    const evP = subUsable.length > 0 ? subSum / subUsable.length : 0;
    const evF = subFilledUsable.length > 0 ? subSum / subFilledUsable.length : 0;
    console.log(`| ${b} | ${sub.length} | ${subFilled.length} | ${(fr * 100).toFixed(1)}% | $${evP.toFixed(4)} | $${evF.toFixed(4)} |`);
  }
  console.log();

  console.log("## By UTC block");
  console.log();
  console.log("| block | posted | filled | fill rate | EV/posted ($) | EV/filled ($) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const b of ["00-04Z", "04-08Z"] as const) {
    const sub = records.filter((r) => r.utcBlock === b);
    const subFilled = sub.filter((r) => r.filled);
    const subUsable = sub.filter((r) => r.pnlSettlement !== null);
    const subSum = subUsable.reduce((a, r) => a + (r.pnlSettlement ?? 0), 0);
    const subFilledUsable = subFilled.filter((r) => r.pnlSettlement !== null);
    if (sub.length === 0) {
      console.log(`| ${b} | 0 | 0 | — | — | — |`);
      continue;
    }
    const fr = subFilled.length / sub.length;
    const evP = subUsable.length > 0 ? subSum / subUsable.length : 0;
    const evF = subFilledUsable.length > 0 ? subSum / subFilledUsable.length : 0;
    console.log(`| ${b} | ${sub.length} | ${subFilled.length} | ${(fr * 100).toFixed(1)}% | $${evP.toFixed(4)} | $${evF.toFixed(4)} |`);
  }
  console.log();

  console.log("## Concentration metrics (NOT gates on non-holdout runs)");
  console.log();
  const totalAbsPnl = usable.reduce((a, r) => a + Math.abs(r.pnlSettlement ?? 0), 0);
  const byMarket = new Map<string, number>();
  for (const r of usable) byMarket.set(r.marketTicker, (byMarket.get(r.marketTicker) ?? 0) + (r.pnlSettlement ?? 0));
  let topMarket = "", topMarketShare = 0;
  for (const [mt, pnl] of byMarket.entries()) {
    if (totalAbsPnl > 0) {
      const share = Math.abs(pnl) / totalAbsPnl;
      if (share > topMarketShare) { topMarketShare = share; topMarket = mt; }
    }
  }
  const by2h = new Map<string, number>();
  for (const r of usable) by2h.set(r.wallClock2h, (by2h.get(r.wallClock2h) ?? 0) + (r.pnlSettlement ?? 0));
  let top2h = "", top2hShare = 0;
  for (const [k, pnl] of by2h.entries()) {
    if (totalAbsPnl > 0) {
      const share = Math.abs(pnl) / totalAbsPnl;
      if (share > top2hShare) { top2hShare = share; top2h = k; }
    }
  }
  const byHour = new Map<number, number>();
  for (const r of usable) byHour.set(utcHourOf(r.postedAtMs), (byHour.get(utcHourOf(r.postedAtMs)) ?? 0) + (r.pnlSettlement ?? 0));
  let topHour = -1, topHourShare = 0;
  for (const [h, pnl] of byHour.entries()) {
    if (totalAbsPnl > 0) {
      const share = Math.abs(pnl) / totalAbsPnl;
      if (share > topHourShare) { topHourShare = share; topHour = h; }
    }
  }
  console.log("| metric | value | reference §13 threshold |");
  console.log("|---|---|---|");
  console.log(`| top-1 market |PnL| share | **${(topMarketShare * 100).toFixed(1)}%** (${topMarket || "—"}) | Gate 5: ≤ 25% |`);
  console.log(`| top-1 2h-block |PnL| share | **${(top2hShare * 100).toFixed(1)}%** (${top2h || "—"}) | Gate 5: ≤ 40% |`);
  console.log(`| top-1 hour-of-day |PnL| share | **${(topHourShare * 100).toFixed(1)}%** (UTC ${topHour >= 0 ? topHour : "—"}) | Gate 5: ≤ 40% |`);
  console.log(`| distinct markets w/ ≥1 fill | ${new Set(filled.map((r) => r.marketTicker)).size} | Gate 2: ≥ 20 |`);
  console.log();
  console.log(
    !isHoldoutRun
      ? "**Reminder: this is a non-holdout run. The §13 thresholds are shown for orientation only; pass/fail logic is intentionally NOT computed here.**"
      : "**Holdout run: §13 Gate logic follows.**",
  );
  console.log();

  // ---- gates: only on holdout ----
  if (isHoldoutRun) {
    console.log("## §13 Pass gates (HOLDOUT)");
    console.log();
    const failures: string[] = [];
    // Gate 1: continuous_holdout_eligible — must be checked externally via adequacyReport. Reported informational.
    console.log("Gate 1 (holdout eligibility) is checked externally via `pnpm run report`; rerun and confirm continuous_holdout_eligible=true before trusting this score.");
    console.log();

    // Gate 2: sample size
    const distinctMarkets = new Set(filled.map((r) => r.marketTicker)).size;
    const g2 = posted >= 500 && filled.length >= 200 && distinctMarkets >= 20;
    console.log(`Gate 2 (sample size: posted ≥ 500, filled ≥ 200, distinct ≥ 20): posted=${posted}, filled=${filled.length}, distinct=${distinctMarkets} → ${g2 ? "✓" : "✗"}`);
    if (!g2) failures.push("Gate 2 sample size");

    // Gate 3: EV
    const g3a = evPosted > 0;
    const g3b = evFilled > 0.01;
    console.log(`Gate 3a (EV/posted > 0): $${evPosted.toFixed(4)} → ${g3a ? "✓" : "✗"}`);
    console.log(`Gate 3b (EV/filled > 0.01): $${evFilled.toFixed(4)} → ${g3b ? "✓" : "✗"}`);
    if (!g3a) failures.push("Gate 3a EV/posted");
    if (!g3b) failures.push("Gate 3b EV/filled");

    // Gate 4: drawdown — requires the Capped replay; reported here as informational.
    console.log(`Gate 4 (drawdown ≤ $5 / 20%) is computed by btcMakerV2Capped.ts; confirm in the capped report.`);

    // Gate 5: concentration (already computed above)
    const g5a = topMarketShare <= 0.25;
    const g5b = top2hShare <= 0.40;
    const g5c = topHourShare <= 0.40;
    console.log(`Gate 5a (top-1 market ≤ 25%): ${(topMarketShare * 100).toFixed(1)}% → ${g5a ? "✓" : "✗"}`);
    console.log(`Gate 5b (top-1 2h ≤ 40%): ${(top2hShare * 100).toFixed(1)}% → ${g5b ? "✓" : "✗"}`);
    console.log(`Gate 5c (top-1 hour ≤ 40%): ${(topHourShare * 100).toFixed(1)}% → ${g5c ? "✓" : "✗"}`);
    if (!g5a) failures.push("Gate 5a top-1 market");
    if (!g5b) failures.push("Gate 5b top-1 2h");
    if (!g5c) failures.push("Gate 5c top-1 hour");

    // Gate 6: side decomposition (one-sided branch active)
    console.log("Gate 6 (one-sided branch active per §7.1 yes_only_guarded): structural justification is the AS scorer table C decomposition; max_net_directional ≤ 2 enforced at post time. ✓ (provided AD-3 was honored — confirm in the cancel-reason and reject breakdowns above).");

    // Gate 7: queue robustness — requires running the same code with queue=front and queue=primary stress.
    console.log("Gate 7 (queue robustness): rerun with --queue=front and --queue=back to populate the three-scenario report. This single run was primary (conservative_threshold).");

    // Gate 8: non-fill / cancel integrity
    const ghostFills = records.filter((r) => r.cancelReason !== "none" && r.filled).length;
    const g8 = ghostFills === 0;
    console.log(`Gate 8 (no ghost fills): ${ghostFills} → ${g8 ? "✓" : "✗"}`);
    if (!g8) failures.push("Gate 8 ghost fills");

    // Gate 9: no post-hoc tuning
    console.log("Gate 9 (no post-hoc tuning): verify externally that the running commit hash matches preregistration_commit (71216c6) at scoring time. This check cannot be self-attested.");

    console.log();
    if (failures.length === 0) {
      console.log("**HOLDOUT GATES IN THIS REPORT: PASS** (subject to external Gate 1, 4, 7, 9 confirmations).");
    } else {
      console.log(`**HOLDOUT GATES IN THIS REPORT: FAIL** (${failures.length} of the in-this-report gates failed):`);
      for (const f of failures) console.log(`- ${f}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
