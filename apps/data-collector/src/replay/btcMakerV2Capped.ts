// =============================================================================
// KXBTC15M_PASSIVE_MAKER_v2 — capped replay (REPLAY-ONLY CAPITAL CAP MODE)
// =============================================================================
//
// Pre-registration: docs/research/kxbtc15m-v2-preregistration.md
//   - policy text locked at commit  71216c6
//   - Status flipped LOCKED at      e65a36b
//
// This file does NOT modify the frozen policy. It mirrors the policy's
// frozen constants verbatim from btcMakerV2.ts (see the "CONSTANTS MIRRORED"
// block below) and layers a capital-cap envelope on top per §8 of the
// preregistration.
//
// Worst-case collateral accounting per §8:
//   locked_collateral = posted_unfilled_reserved + filled_open_exposure_worst_case
//   filled_open_exposure_worst_case is max_loss of each unsettled position,
//   NOT mark-to-market. Applies even if the strategy is hold-to-settlement
//   (see preregistration §8 hold-to-settlement clause).
//
// Two output regimes mirror btcMakerV2.ts:
//   - --label contains "holdout"          → Gate 4 (drawdown) verdict computed
//   - any other label                      → metrics only; no gate verdict
//
// Run:
//   pnpm exec tsx src/replay/btcMakerV2Capped.ts --log-dir=... --label=sanity-check-...
//
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
// CONSTANTS MIRRORED FROM btcMakerV2.ts — DO NOT DIVERGE
// =============================================================================
// If the frozen policy ever changes, both files must update together AND a new
// preregistration version is required (v2 itself cannot change). Duplicated
// (rather than imported) so each file is standalone-readable. Per v1Capped's
// same discipline.

const POLICY_NAME = "KXBTC15M_PASSIVE_MAKER_v2";
const PREREG_DOC = "docs/research/kxbtc15m-v2-preregistration.md";
const PREREG_COMMIT_A = "71216c6";
const PREREG_LOCK_COMMIT = "e65a36b";

const SERIES = "KXBTC15M";
const SIDE = "yes" as const;
const SIZE_CONTRACTS = 1;

const QUOTE_DURATION_MS = 75_000;
const CANCEL_ON_SPREAD_WIDEN = true;
const CANCEL_ON_QUEUE_DETERIORATION = true;
const SPREAD_WIDEN_THRESHOLD_TICKS = 1;

const TTE_MIN_MS = 360_000;
const TTE_MAX_MS = 840_000;
const ALLOWED_UTC_HOURS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

const MIN_SPREAD_TICKS = 1;
const MONEYNESS_MIN = 0.15;
const MONEYNESS_MAX = 0.40;

const MAX_NET_DIRECTIONAL_CONTRACTS = 2;
const MAX_CONTRACTS_PER_MARKET = 1;

const QUEUE_ASSUMPTION = { type: "back" as const };

const ANCHOR_PERIOD_MS = 60_000;
const ANCHOR_RUNWAY_MS = 60_000;

// =============================================================================
// CAP ENVELOPE (preregistration §8)
// =============================================================================

interface CapsConfig {
  bankrollDollars: number;
  maxQuoteCollateralDollars: number;
  maxTotalLockedCollateralDollars: number;
  maxReplayDrawdownDollars: number;
  maxReplayDrawdownPct: number;
}

const CAPS: CapsConfig = {
  bankrollDollars: 25.0,
  maxQuoteCollateralDollars: 1.0,
  maxTotalLockedCollateralDollars: 5.0,
  maxReplayDrawdownDollars: 5.0,
  maxReplayDrawdownPct: 0.20,
};

// =============================================================================
// Helpers (mirrored from btcMakerV2.ts)
// =============================================================================

function isBtcMarket(mt: string): boolean { return mt.startsWith(SERIES + "-"); }
function utcHourOf(tsMs: number): number { return new Date(tsMs).getUTCHours(); }
function tteOk(tteMs: number): boolean { return tteMs >= TTE_MIN_MS && tteMs <= TTE_MAX_MS; }
function utcHourOk(tsMs: number): boolean { return ALLOWED_UTC_HOURS.has(utcHourOf(tsMs)); }
function moneynessOk(p: number): boolean {
  const m = Math.abs(p - 0.5);
  return m >= MONEYNESS_MIN && m <= MONEYNESS_MAX;
}
function priceTicksOf(p: number): number { return priceToTicks(p.toFixed(4)); }

function applyAny(state: KalshiBookState, ev: BookEvent): void {
  if (ev.type === "snapshot") applySnapshot(state, ev);
  else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
  else applyDelta(state, ev);
}

// =============================================================================
// Settlement inference (v1-compatible, mirrored)
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
// v2 simulator wrapper (mirrored from btcMakerV2.ts — DO NOT DIVERGE)
// =============================================================================

type CancelReason =
  | "none" | "ttl" | "spread_widen" | "queue_deterioration"
  | "level_depleted" | "market_terminated";

interface V2SimResult {
  filled: boolean;
  fillTsMs: number | null;
  fillFraction: number;
  cancelReason: CancelReason;
}

function findCancelTrigger(
  mIdx: MarketIndex,
  postedAtMs: number,
  stopTs: number,
  spreadAtPostTicks: number,
  bestYesBidAtPostTicks: number,
): { ts: number; reason: CancelReason } | null {
  const state: KalshiBookState = newBookState(mIdx.marketTicker, "");
  let i = 0;
  while (i < mIdx.bookEvents.length) {
    const ev = mIdx.bookEvents[i] as BookEvent;
    if (ev.tsMs > postedAtMs) break;
    applyAny(state, ev);
    i += 1;
  }
  for (; i < mIdx.bookEvents.length; i++) {
    const ev = mIdx.bookEvents[i] as BookEvent;
    if (ev.tsMs > stopTs) break;
    applyAny(state, ev);
    const curBid = bestYesBid(state);
    const curAsk = bestYesAsk(state);
    if (CANCEL_ON_QUEUE_DETERIORATION && curBid !== null) {
      if (priceTicksOf(curBid) > bestYesBidAtPostTicks) {
        return { ts: ev.tsMs, reason: "queue_deterioration" };
      }
    }
    if (CANCEL_ON_SPREAD_WIDEN && curBid !== null && curAsk !== null) {
      const curSpread = curAsk - curBid;
      if (priceTicksOf(curSpread) > spreadAtPostTicks + SPREAD_WIDEN_THRESHOLD_TICKS) {
        return { ts: ev.tsMs, reason: "spread_widen" };
      }
    }
  }
  return null;
}

function simulateQuoteV2(
  quote: HypotheticalQuote,
  mIdx: MarketIndex,
  spreadAtPostTicks: number,
  bestYesBidAtPostTicks: number,
): V2SimResult {
  const r = simulateQuote(quote, mIdx, QUOTE_DURATION_MS);
  if (r.filled && r.fillTsMs !== null) {
    const trig = findCancelTrigger(mIdx, quote.postedAtMs, r.fillTsMs, spreadAtPostTicks, bestYesBidAtPostTicks);
    if (trig !== null && trig.ts < r.fillTsMs) {
      return { filled: false, fillTsMs: null, fillFraction: 0, cancelReason: trig.reason };
    }
    return { filled: true, fillTsMs: r.fillTsMs, fillFraction: r.fillFraction, cancelReason: "none" };
  }
  const ttlEnd = quote.postedAtMs + QUOTE_DURATION_MS;
  const trig = findCancelTrigger(mIdx, quote.postedAtMs, ttlEnd, spreadAtPostTicks, bestYesBidAtPostTicks);
  if (trig !== null) {
    return { filled: false, fillTsMs: null, fillFraction: 0, cancelReason: trig.reason };
  }
  let cancelReason: CancelReason = "ttl";
  if (r.marketTerminated) cancelReason = "market_terminated";
  else if (r.levelDepleted) cancelReason = "level_depleted";
  return { filled: false, fillTsMs: null, fillFraction: 0, cancelReason };
}

// =============================================================================
// Cap admission (worst-case collateral, §8)
// =============================================================================

type CapBlockReason = "quote_size_cap" | "exposure_cap" | "bankroll_exhausted";

interface OpenPosition {
  marketTicker: string;
  side: "yes" | "no";
  pricePaid: number;
  size: number;
  filledAtMs: number;
  settleAtMs: number;
}

// max_loss per §8: YES-bid at $P_y size N → max_loss = P_y × N (all-zero settle)
function maxLossOf(pos: OpenPosition): number {
  return pos.side === "yes" ? pos.pricePaid * pos.size : pos.pricePaid * pos.size;
}

interface CapState {
  bankroll: number;
  openPositions: OpenPosition[];
  // posted_unfilled_reserved is tracked separately because in the replay
  // we know whether each quote fills or not BEFORE the next anchor, so the
  // "reserved" envelope is checked only at quote admission, not over time.
}

interface CapDecision {
  allowed: boolean;
  reason: CapBlockReason | null;
  reservedAtPostUsd: number;
  reservedFromFilledOpenUsd: number;
}

function decideCapAdmission(
  state: CapState,
  quoteCollateralUsd: number,
  nowMs: number,
): CapDecision {
  if (quoteCollateralUsd > CAPS.maxQuoteCollateralDollars + 1e-9) {
    return { allowed: false, reason: "quote_size_cap", reservedAtPostUsd: quoteCollateralUsd, reservedFromFilledOpenUsd: 0 };
  }
  // Worst-case accounting:
  //   posted_unfilled_reserved = quoteCollateralUsd (this quote, 100% fill possibility)
  //   filled_open_worst_case   = sum of max_loss(p) for p in openPositions where settleAtMs > nowMs
  let openMaxLossSum = 0;
  for (const p of state.openPositions) {
    if (p.settleAtMs > nowMs) openMaxLossSum += maxLossOf(p);
  }
  const locked = quoteCollateralUsd + openMaxLossSum;
  if (locked > CAPS.maxTotalLockedCollateralDollars + 1e-9) {
    return { allowed: false, reason: "exposure_cap", reservedAtPostUsd: quoteCollateralUsd, reservedFromFilledOpenUsd: openMaxLossSum };
  }
  if (state.bankroll < quoteCollateralUsd) {
    return { allowed: false, reason: "bankroll_exhausted", reservedAtPostUsd: quoteCollateralUsd, reservedFromFilledOpenUsd: openMaxLossSum };
  }
  return { allowed: true, reason: null, reservedAtPostUsd: quoteCollateralUsd, reservedFromFilledOpenUsd: openMaxLossSum };
}

// =============================================================================
// Main
// =============================================================================

interface Args { logDir: string; label: string }
function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return {
    logDir: args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector"),
    label: args.label ?? "sanity-check-capped-unlabeled",
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const isHoldoutRun = args.label.toLowerCase().includes("holdout");
  process.stderr.write(`[${POLICY_NAME} | capped] preregistration: ${PREREG_DOC} (commit A ${PREREG_COMMIT_A}, lock ${PREREG_LOCK_COMMIT})\n`);
  process.stderr.write(`[${POLICY_NAME} | capped] caps: bankroll=$${CAPS.bankrollDollars} maxQuote=$${CAPS.maxQuoteCollateralDollars} maxLocked=$${CAPS.maxTotalLockedCollateralDollars} maxDD=$${CAPS.maxReplayDrawdownDollars}/${CAPS.maxReplayDrawdownPct * 100}%\n`);
  process.stderr.write(`[${POLICY_NAME} | capped] gate verdict: ${isHoldoutRun ? "ENABLED — holdout" : "DISABLED — non-holdout"}\n`);

  const t0 = Date.now();
  process.stderr.write(`[${POLICY_NAME} | capped] building market index for ${SERIES}...\n`);
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(`[${POLICY_NAME} | capped] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const settlements = new Map<string, SettlementLabel>();
  const marketLastTs = new Map<string, number>();
  for (const [mt, m] of idx.entries()) {
    const lastBook = m.bookEvents[m.bookEvents.length - 1];
    marketLastTs.set(mt, lastBook ? lastBook.tsMs : -1);
    const lastTrade = m.trades[m.trades.length - 1];
    settlements.set(mt, inferSettlement(m.midTs, m.midYes, lastTrade ? lastTrade.tsMs : -1, lastTrade ? lastTrade.yesPrice : Number.NaN));
  }

  // Enumerate eligible anchors globally in time order.
  type Anchor = { marketTicker: string; tsMs: number; tteMs: number };
  const anchors: Anchor[] = [];
  for (const m of idx.values()) {
    if (m.bookEvents.length < 10) continue;
    const first = m.bookEvents[0]!.tsMs;
    const last = m.bookEvents[m.bookEvents.length - 1]!.tsMs;
    if (last - first < 2 * ANCHOR_PERIOD_MS) continue;
    const lastAnchor = last - ANCHOR_RUNWAY_MS;
    for (let ts = first + ANCHOR_PERIOD_MS; ts <= lastAnchor; ts += ANCHOR_PERIOD_MS) {
      anchors.push({ marketTicker: m.marketTicker, tsMs: ts, tteMs: last - ts });
    }
  }
  anchors.sort((a, b) => a.tsMs - b.tsMs);
  process.stderr.write(`[${POLICY_NAME} | capped] ${anchors.length.toLocaleString()} candidate anchors\n`);

  // Cap-aware simulation: time-ordered with bankroll + open position tracking.
  const cap: CapState = { bankroll: CAPS.bankrollDollars, openPositions: [] };
  const marketAliveUntilMs = new Map<string, number>();

  let totalCandidates = 0;
  let postedPolicy = 0;        // passed policy filters
  let allowedByCap = 0;        // passed cap admission
  let filledAllowed = 0;
  let blockedByPolicyReject = 0;
  const policyRejectCounts: Record<string, number> = {};
  const capBlockCounts: Record<string, number> = { quote_size_cap: 0, exposure_cap: 0, bankroll_exhausted: 0 };

  interface CashEvent { tsMs: number; bankroll: number; openMaxLoss: number; openCount: number }
  const cashTrajectory: CashEvent[] = [{ tsMs: anchors.length > 0 ? anchors[0]!.tsMs : 0, bankroll: cap.bankroll, openMaxLoss: 0, openCount: 0 }];

  interface FilledRecord {
    marketTicker: string;
    postedAtMs: number;
    filledAtMs: number;
    settleAtMs: number;
    touchPrice: number;
    settlementValue: number | null;
    pnlSettlement: number | null;
    durationMs: number;
  }
  const filledRecords: FilledRecord[] = [];

  function settleDuePositions(nowMs: number): void {
    let writeIdx = 0;
    for (let i = 0; i < cap.openPositions.length; i++) {
      const p = cap.openPositions[i]!;
      if (p.settleAtMs <= nowMs) {
        // Settle this position into bankroll.
        const settlement = settlements.get(p.marketTicker)!;
        if (settlement.value !== null) {
          // YES-bid PnL = (S - pricePaid) * size; bankroll grows by (S × size) and loses
          // the locked pricePaid × size. Net effect on bankroll: (S - pricePaid) × size.
          const pnl = (settlement.value - p.pricePaid) * p.size;
          cap.bankroll += pnl;
          // Update the matching record's PnL
          for (const rec of filledRecords) {
            if (rec.marketTicker === p.marketTicker && rec.filledAtMs === p.filledAtMs) {
              rec.pnlSettlement = pnl;
              break;
            }
          }
        }
      } else {
        cap.openPositions[writeIdx++] = p;
      }
    }
    cap.openPositions.length = writeIdx;
  }

  for (const a of anchors) {
    totalCandidates += 1;
    settleDuePositions(a.tsMs);
    // Prune alive-quote windows
    for (const [mt, until] of Array.from(marketAliveUntilMs.entries())) {
      if (until <= a.tsMs) marketAliveUntilMs.delete(mt);
    }

    const m = idx.get(a.marketTicker)!;
    // Policy filters (mirrored from btcMakerV2.ts)
    if (!tteOk(a.tteMs)) { blockedByPolicyReject += 1; policyRejectCounts.tte_filter = (policyRejectCounts.tte_filter ?? 0) + 1; continue; }
    if (!utcHourOk(a.tsMs)) { blockedByPolicyReject += 1; policyRejectCounts.utc_hour_filter = (policyRejectCounts.utc_hour_filter ?? 0) + 1; continue; }

    const state: KalshiBookState = newBookState(a.marketTicker, "");
    for (const ev of m.bookEvents) {
      if (ev.tsMs > a.tsMs) break;
      applyAny(state, ev);
    }
    const yb = bestYesBid(state);
    if (yb === null) { blockedByPolicyReject += 1; policyRejectCounts.no_touch_available = (policyRejectCounts.no_touch_available ?? 0) + 1; continue; }
    if (!moneynessOk(yb)) { blockedByPolicyReject += 1; policyRejectCounts.moneyness_filter = (policyRejectCounts.moneyness_filter ?? 0) + 1; continue; }
    const ya = bestYesAsk(state);
    if (ya === null) { blockedByPolicyReject += 1; policyRejectCounts.no_touch_available = (policyRejectCounts.no_touch_available ?? 0) + 1; continue; }
    const spreadTicks = priceTicksOf(ya - yb);
    if (spreadTicks < MIN_SPREAD_TICKS) { blockedByPolicyReject += 1; policyRejectCounts.spread_floor = (policyRejectCounts.spread_floor ?? 0) + 1; continue; }
    // Inventory caps
    const liveOpenCount = cap.openPositions.filter((p) => p.settleAtMs > a.tsMs).length;
    if (liveOpenCount + 1 > MAX_NET_DIRECTIONAL_CONTRACTS) { blockedByPolicyReject += 1; policyRejectCounts.inventory_cap = (policyRejectCounts.inventory_cap ?? 0) + 1; continue; }
    if (marketAliveUntilMs.has(a.marketTicker) || cap.openPositions.some((p) => p.marketTicker === a.marketTicker)) {
      blockedByPolicyReject += 1; policyRejectCounts.per_market_cap = (policyRejectCounts.per_market_cap ?? 0) + 1;
      continue;
    }

    postedPolicy += 1;

    // CAP admission (worst-case)
    const quoteCollateral = yb * SIZE_CONTRACTS;
    const decision = decideCapAdmission(cap, quoteCollateral, a.tsMs);
    if (!decision.allowed) {
      capBlockCounts[decision.reason!] = (capBlockCounts[decision.reason!] ?? 0) + 1;
      continue;
    }
    allowedByCap += 1;
    marketAliveUntilMs.set(a.marketTicker, a.tsMs + QUOTE_DURATION_MS);

    // Simulate
    const quote: HypotheticalQuote = {
      marketTicker: a.marketTicker,
      side: SIDE,
      priceDollars: yb,
      sizeContracts: SIZE_CONTRACTS,
      postedAtMs: a.tsMs,
      queue: QUEUE_ASSUMPTION,
    };
    const r = simulateQuoteV2(quote, m, spreadTicks, priceTicksOf(yb));

    if (r.filled && r.fillTsMs !== null) {
      filledAllowed += 1;
      // Bankroll = realized cash position. Does NOT decrease at fill — the
      // collateral commitment is tracked separately via openPositions
      // (consulted by decideCapAdmission for the exposure_cap check). This
      // matches v1Capped's documented "max drawdown is realized-only,
      // computed from the cash trajectory at SETTLE events" semantics.
      // The earlier draft of this file deducted at fill AND added PnL at
      // settle, which double-counted the collateral; that was an
      // implementation bug, not a spec issue. Spec §8 unchanged.
      const settleTs = marketLastTs.get(a.marketTicker) ?? r.fillTsMs;
      const pos: OpenPosition = {
        marketTicker: a.marketTicker,
        side: SIDE,
        pricePaid: yb,
        size: SIZE_CONTRACTS,
        filledAtMs: r.fillTsMs,
        settleAtMs: settleTs,
      };
      cap.openPositions.push(pos);
      filledRecords.push({
        marketTicker: a.marketTicker,
        postedAtMs: a.tsMs,
        filledAtMs: r.fillTsMs,
        settleAtMs: settleTs,
        touchPrice: yb,
        settlementValue: settlements.get(a.marketTicker)?.value ?? null,
        pnlSettlement: null, // filled in at settlement
        durationMs: settleTs - r.fillTsMs,
      });
    }

    // Record cash trajectory at this anchor (post-anchor state).
    let openMaxLoss = 0;
    let openCount = 0;
    for (const p of cap.openPositions) {
      if (p.settleAtMs > a.tsMs) {
        openMaxLoss += maxLossOf(p);
        openCount += 1;
      }
    }
    cashTrajectory.push({ tsMs: a.tsMs, bankroll: cap.bankroll, openMaxLoss, openCount });
  }

  // Final settlement of any remaining positions (after the last anchor).
  const finalNowMs = anchors.length > 0 ? anchors[anchors.length - 1]!.tsMs + 24 * 3600 * 1000 : 0;
  settleDuePositions(finalNowMs);
  cashTrajectory.push({ tsMs: finalNowMs, bankroll: cap.bankroll, openMaxLoss: 0, openCount: 0 });

  // ---- Drawdown computation ----
  let peak = CAPS.bankrollDollars;
  let maxDD = 0;
  for (const c of cashTrajectory) {
    if (c.bankroll > peak) peak = c.bankroll;
    const dd = peak - c.bankroll;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPct = maxDD / CAPS.bankrollDollars;

  // ---- Capital utilization ----
  let exposureTimeIntegral = 0;
  for (let i = 1; i < cashTrajectory.length; i++) {
    const prev = cashTrajectory[i - 1]!;
    const cur = cashTrajectory[i]!;
    exposureTimeIntegral += prev.openMaxLoss * (cur.tsMs - prev.tsMs);
  }
  const tStart = filledRecords.length > 0 ? filledRecords[0]!.postedAtMs : (anchors.length > 0 ? anchors[0]!.tsMs : 0);
  const tEnd = finalNowMs;
  const activeMs = Math.max(1, tEnd - tStart);
  const avgExposure = exposureTimeIntegral / activeMs;
  const utilizationPct = avgExposure / CAPS.maxTotalLockedCollateralDollars;

  // ---- Realized PnL ----
  let realizedPnl = 0;
  for (const r of filledRecords) if (r.pnlSettlement !== null) realizedPnl += r.pnlSettlement;
  const evPerAllowedPosted = allowedByCap > 0 ? realizedPnl / allowedByCap : 0;
  const filledWithPnl = filledRecords.filter((r) => r.pnlSettlement !== null);
  const evPerAllowedFilled = filledWithPnl.length > 0 ? realizedPnl / filledWithPnl.length : 0;

  // ---- Exposure duration ----
  const durations = filledRecords.map((r) => r.durationMs);
  const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0;

  // =========================================================================
  // REPORT
  // =========================================================================
  console.log();
  console.log(`# ${POLICY_NAME} — capped replay — \`${args.label}\``);
  console.log();
  if (!isHoldoutRun) {
    console.log("> **IMPLEMENTATION SANITY CHECK — CAPPED REPLAY — NOT VALIDATION.**");
    console.log("> Non-holdout dataset. Drawdown is reported as a metric; the §13 Gate 4");
    console.log("> verdict is NOT computed (operator guardrail #4). Purpose: confirm the");
    console.log("> cap envelope mechanics (worst-case collateral accounting per §8, the");
    console.log("> $1 quote / $5 locked / $5 drawdown thresholds, hold-to-settlement");
    console.log("> exposure handling) execute without error.");
  } else {
    console.log("> **HOLDOUT — CAPPED REPLAY.** §13 Gate 4 (drawdown ≤ 20%/$5) verdict computed below.");
  }
  console.log();
  console.log(`- Policy:           ${POLICY_NAME}`);
  console.log(`- Preregistration:  ${PREREG_DOC}`);
  console.log(`- Locked at:        commit A ${PREREG_COMMIT_A}, lock ${PREREG_LOCK_COMMIT}`);
  console.log(`- Log dir:          ${args.logDir}`);
  console.log(`- Markets indexed:  ${idx.size}`);
  console.log();

  console.log("## Capital envelope under test");
  console.log();
  console.log("| cap | value |");
  console.log("|---|---:|");
  console.log(`| bankroll | $${CAPS.bankrollDollars.toFixed(2)} |`);
  console.log(`| max quote collateral | $${CAPS.maxQuoteCollateralDollars.toFixed(2)} |`);
  console.log(`| max total locked collateral | $${CAPS.maxTotalLockedCollateralDollars.toFixed(2)} |`);
  console.log(`| max replay drawdown | $${CAPS.maxReplayDrawdownDollars.toFixed(2)} (${(CAPS.maxReplayDrawdownPct * 100).toFixed(0)}%) |`);
  console.log();

  console.log("## Admission funnel");
  console.log();
  console.log("| stage | count |");
  console.log("|---|---:|");
  console.log(`| candidate anchors | ${totalCandidates.toLocaleString()} |`);
  console.log(`| blocked by policy filters | ${blockedByPolicyReject.toLocaleString()} |`);
  console.log(`| passed policy filters (would post unconstrained) | ${postedPolicy.toLocaleString()} |`);
  console.log(`| allowed by cap envelope | **${allowedByCap.toLocaleString()}** |`);
  console.log(`| — blocked by cap: quote_size_cap | ${capBlockCounts.quote_size_cap} |`);
  console.log(`| — blocked by cap: exposure_cap | ${capBlockCounts.exposure_cap} |`);
  console.log(`| — blocked by cap: bankroll_exhausted | ${capBlockCounts.bankroll_exhausted} |`);
  console.log(`| allowed & filled | ${filledAllowed.toLocaleString()} (${allowedByCap > 0 ? ((100 * filledAllowed) / allowedByCap).toFixed(1) : "n/a"}% of allowed) |`);
  console.log();

  console.log("## Policy reject breakdown (within cap envelope)");
  console.log();
  console.log("| reason | count |");
  console.log("|---|---:|");
  for (const [k, v] of Object.entries(policyRejectCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${k} | ${v} |`);
  }
  console.log();

  console.log("## P&L under cap");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| starting bankroll | $${CAPS.bankrollDollars.toFixed(4)} |`);
  console.log(`| ending bankroll | $${cap.bankroll.toFixed(4)} |`);
  console.log(`| realized PnL | ${realizedPnl >= 0 ? "+" : "-"}$${Math.abs(realizedPnl).toFixed(4)} |`);
  console.log(`| EV per allowed posted | ${evPerAllowedPosted >= 0 ? "+" : "-"}$${Math.abs(evPerAllowedPosted).toFixed(4)} |`);
  console.log(`| EV per allowed filled | ${evPerAllowedFilled >= 0 ? "+" : "-"}$${Math.abs(evPerAllowedFilled).toFixed(4)} |`);
  console.log(`| max drawdown | **$${maxDD.toFixed(4)} (${(maxDDPct * 100).toFixed(1)}% of bankroll)** |`);
  console.log();

  console.log("## Capital utilization");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| active window | ${(activeMs / 3_600_000).toFixed(2)} h |`);
  console.log(`| time-avg locked (worst-case open + reserved) | $${avgExposure.toFixed(4)} |`);
  console.log(`| utilization (avg locked / max-locked-cap) | ${(utilizationPct * 100).toFixed(1)}% |`);
  console.log();

  console.log("## Exposure duration (per filled position)");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| filled positions | ${filledRecords.length.toLocaleString()} |`);
  console.log(`| mean duration | ${(avgDurationMs / 1000).toFixed(1)} s |`);
  console.log(`| max duration | ${(maxDurationMs / 1000).toFixed(1)} s |`);
  console.log();

  console.log("## Worst-case collateral accounting note (§8)");
  console.log();
  console.log("Filled-but-unsettled positions consume their full max_loss against the");
  console.log("$5 locked-collateral cap (NOT mark-to-market). This applies even though");
  console.log("v2 is hold-to-settlement — exit value cannot be relied upon for cap relief.");
  console.log("Cap blocks reported as `exposure_cap` reflect this worst-case math.");
  console.log();

  if (isHoldoutRun) {
    console.log("## §13 Gate 4 verdict (holdout)");
    console.log();
    const g4 = maxDD <= CAPS.maxReplayDrawdownDollars + 1e-9 && maxDDPct <= CAPS.maxReplayDrawdownPct + 1e-9;
    console.log(`max drawdown ≤ $${CAPS.maxReplayDrawdownDollars}? $${maxDD.toFixed(4)} → ${g4 ? "✓ PASS" : "✗ FAIL"}`);
    if (!g4) {
      console.log();
      console.log(`**HOLDOUT GATE 4 FAIL** — drawdown $${maxDD.toFixed(4)} (${(maxDDPct * 100).toFixed(1)}%) exceeds the ${CAPS.maxReplayDrawdownPct * 100}% / $${CAPS.maxReplayDrawdownDollars} cap. v2 is rejected.`);
      process.exitCode = 1;
    } else {
      console.log();
      console.log("**HOLDOUT GATE 4 PASS** (drawdown gate only — other gates in btcMakerV2.ts report).");
    }
  } else {
    console.log("**Reminder: drawdown reported as a metric, not as a gate verdict, for this non-holdout run.**");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
