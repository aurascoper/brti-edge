// REPLAY-ONLY CAPITAL-CAP MODE for BTC_YES_LATE_ASIA_v1.
//
// This file does NOT modify the frozen policy. It mirrors the policy's
// frozen constants verbatim (see CONSTANTS MIRRORED FROM btcYesLateAsiaV1.ts
// block below) and layers a capital-cap envelope on top:
//
//   - bankroll/capital cap:        $25
//   - max quote size (collateral): $1
//   - max simultaneous exposure:   $5
//
// Purpose: characterize what the frozen policy would look like operating
// inside a small-bankroll envelope, so we can design the eventual live
// canary intelligently. THIS IS NOT VALIDATION. Official validation still
// requires (a) a distinct-week holdout window with continuous_holdout_eligible
// = true, and (b) the uncapped pre-registered replay clearing its 7 gates
// on that holdout.
//
// Run:
//   pnpm exec tsx src/replay/btcYesLateAsiaV1Capped.ts
//   pnpm exec tsx src/replay/btcYesLateAsiaV1Capped.ts --label=prerun-infra
//
// ---------------------------------------------------------------------------
// Design choices (read this before changing anything)
// ---------------------------------------------------------------------------
//
// Each anchor in the existing replay is an INDEPENDENT hypothetical quote.
// In the same market, anchors fire 60s apart; their hypothetical fills can
// stack. We carry that semantics through to the capped replay — multiple
// concurrent anchors in the same market count as multiple positions in the
// open-exposure book. A live maker that cancels-and-replaces would coalesce
// these into one rolling position; we accept the overstatement here because
// it is the more conservative envelope (more exposure → cap binds sooner →
// stricter test of the envelope, not laxer).
//
// Exposure definition:  for a YES bid, the collateral risked = priceDollars
// × fillFraction × sizeContracts. That is what Kalshi locks at fill time.
// Released back to bankroll on settlement, with realized PnL added/subtracted.
//
// Settlement timestamp: the last bookEvent ts in a market is treated as
// "settled". Matches the heuristic in btcYesLateAsiaV1.ts.
//
// Cap-enforcement decision rule lives in decideCapAction(). It is the one
// policy bit in this file and is marked as such. The other entries of this
// file are mechanical accounting.

import { resolve } from "node:path";
import {
  applyDelta,
  applySnapshot,
  applyTerminalSnapshot,
  bestYesBid,
  newBookState,
} from "./bookReconstructor.js";
import {
  buildMarketIndex,
  simulateQuote,
  type HypotheticalQuote,
  type QueueAssumption,
} from "./queueModel.js";

// =========================================================================
// CONSTANTS MIRRORED FROM btcYesLateAsiaV1.ts — DO NOT DIVERGE
// =========================================================================
// If the frozen policy ever changes, both files must update together. The
// constants are duplicated here (rather than imported) because the
// pre-registered file does not export them, and reaching into it to add
// `export` would touch the frozen policy file. Keeping them duplicated with
// this warning is the lesser evil.

const POLICY_NAME = "BTC_YES_LATE_ASIA_v1";
const PREREG_DOC = "docs/research/kalshi-policy-preregistration-btc-yes-late-asia-v1-2026-05-26.md";

const SERIES = "KXBTC15M";
const SIDE = "yes" as const;
const SIZE_CONTRACTS = 1;
const QUEUE_ASSUMPTION: QueueAssumption = { type: "depth_fraction", fraction: 0.5 };

const TTE_MIN_MINUTES = 6;
function isEligibleHour(utcHour: number): boolean {
  return (utcHour >= 20 && utcHour < 24) || (utcHour >= 0 && utcHour < 8);
}

const ANCHOR_PERIOD_MS = 60_000;
const ANCHOR_RUNWAY_MS = 60_000;

function isBtcMarket(mt: string): boolean { return mt.startsWith(SERIES + "-"); }

interface SettlementLabel {
  value: number | null;
  confidence: "high" | "low" | "none";
}
function inferSettlement(midTs: number[], midYes: number[], lastTradeTs: number, lastTradeYesPrice: number): SettlementLabel {
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

// =========================================================================
// CAP CONFIGURATION (the small-bankroll envelope under test)
// =========================================================================

interface CapsConfig {
  bankrollDollars: number;     // total starting capital available
  maxQuoteSizeDollars: number; // max collateral per single quote
  maxOpenExposureDollars: number; // max sum of open-position collateral at once
}

const CAPS: CapsConfig = {
  bankrollDollars: 25,
  maxQuoteSizeDollars: 1,
  maxOpenExposureDollars: 5,
};

// =========================================================================
// PORTFOLIO STATE & EVENT TIMELINE
// =========================================================================

interface OpenPosition {
  marketTicker: string;
  postedAtMs: number;
  filledAtMs: number;
  settleAtMs: number;
  collateral: number;          // priceDollars × fillFraction × sizeContracts
  expectedPnl: number | null;  // (settlement − price) × fillFraction × sizeContracts, null if settlement unknown
}

interface PortfolioState {
  bankroll: number;            // current realized cash (start = CAPS.bankrollDollars)
  openExposure: number;        // sum of collateral on FILLED open positions
  reservedExposure: number;    // sum of collateral on POSTED-but-unresolved quotes
  openPositions: OpenPosition[];
}

type CapDecisionReason = "quote_size_cap" | "exposure_cap" | "bankroll_exhausted";
type CapDecision = { kind: "allow" } | { kind: "block"; reason: CapDecisionReason };

// =========================================================================
// CAP-ENFORCEMENT POLICY (THE ONE NON-MECHANICAL BIT — see header notes)
// =========================================================================
//
// Decides whether the policy is allowed to post `quote` given current
// portfolio `state` and configured `caps`. Returns allow or a block with a
// labeled reason (so the report can categorize denials).
//
// POLICY (user-locked, 2026-05-26):
//   1. Per-quote collateral must be ≤ maxQuoteSizeDollars.
//   2. Total locked collateral (filled openExposure + posted-but-unresolved
//      reservedExposure + this quote's worst-case collateral) must be
//      ≤ maxOpenExposureDollars. Reservation mirrors Kalshi's collateral-
//      lock-at-order-placement behavior — the cap is what a live maker
//      would actually see on their bankroll, not just realized open risk.
//   3. Total locked + this quote must not exceed bankroll. Equivalent to
//      "we have free cash to reserve this new quote even if every prior
//      locked dollar goes against us".
//
// Worst-case fill assumption: collateral is computed as priceDollars × full
// sizeContracts (no fillFraction discount). Conservative — biases toward
// blocking. Safer for canary design.
//
// Alternative semantics intentionally not adopted:
//   * Expected-fill sizing would let more posts through but adds a
//     parameter (E[fillFraction]) learned from the same data, with mild
//     leakage risk.
//   * Per-market position coalescing (cancel-and-replace) would lower the
//     count of concurrent positions in the same market. We keep them split
//     as the more conservative envelope — the cap binds sooner here than
//     in a coalesced model, which is the right direction for canary sizing.
function decideCapAction(state: PortfolioState, quote: HypotheticalQuote, caps: CapsConfig): CapDecision {
  const quoteCollateral = quote.priceDollars * quote.sizeContracts;
  if (quoteCollateral > caps.maxQuoteSizeDollars) {
    return { kind: "block", reason: "quote_size_cap" };
  }
  const totalLocked = state.openExposure + state.reservedExposure;
  if (totalLocked + quoteCollateral > caps.maxOpenExposureDollars) {
    return { kind: "block", reason: "exposure_cap" };
  }
  if (state.bankroll - totalLocked - quoteCollateral < 0) {
    return { kind: "block", reason: "bankroll_exhausted" };
  }
  return { kind: "allow" };
}

// =========================================================================
// REPLAY (chronological event timeline, single pass)
// =========================================================================

interface Args { logDir: string; label: string }
function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return {
    logDir: args["log-dir"] ?? resolve(process.cwd(), "logs/data-collector"),
    label: args.label ?? "prerun-capped",
  };
}

interface PostAttempt {
  marketTicker: string;
  postedAtMs: number;
  priceDollars: number;
  // Outcome of simulating the quote (independent of cap). Resolved up front
  // so the cap-enforcement walk can be a simple chronological loop.
  filled: boolean;
  fillTsMs: number | null;
  fillFraction: number;
  collateralIfFilled: number;   // priceDollars × fillFraction × sizeContracts
  settlementValue: number | null;
  settleAtMs: number;           // market last-bookEvent ts
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.stderr.write(`[${POLICY_NAME} | capped] pre-registration: ${PREREG_DOC}\n`);
  process.stderr.write(`[${POLICY_NAME} | capped] log dir: ${args.logDir}\n`);
  process.stderr.write(`[${POLICY_NAME} | capped] label: ${args.label}\n`);
  process.stderr.write(`[${POLICY_NAME} | capped] caps: bankroll=$${CAPS.bankrollDollars} maxQuote=$${CAPS.maxQuoteSizeDollars} maxExposure=$${CAPS.maxOpenExposureDollars}\n`);

  // ----- pass 1: generate every anchor and resolve its fill independently
  const t0 = Date.now();
  process.stderr.write(`[${POLICY_NAME} | capped] building BTC market index...\n`);
  const idx = await buildMarketIndex(args.logDir, isBtcMarket);
  process.stderr.write(`[${POLICY_NAME} | capped] indexed ${idx.size} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const settlements = new Map<string, SettlementLabel>();
  for (const [mt, m] of idx.entries()) {
    const lastTrade = m.trades[m.trades.length - 1];
    settlements.set(mt, inferSettlement(
      m.midTs, m.midYes,
      lastTrade ? lastTrade.tsMs : -1,
      lastTrade ? lastTrade.yesPrice : Number.NaN
    ));
  }

  const attempts: PostAttempt[] = [];
  const tSim = Date.now();
  for (const m of idx.values()) {
    if (m.bookEvents.length < 10) continue;
    const first = m.bookEvents[0]!.tsMs;
    const last = m.bookEvents[m.bookEvents.length - 1]!.tsMs;
    if (last - first < 2 * ANCHOR_PERIOD_MS) continue;
    const lastAnchor = last - ANCHOR_RUNWAY_MS;
    const settlement = settlements.get(m.marketTicker)!;

    for (let anchorTs = first + ANCHOR_PERIOD_MS; anchorTs <= lastAnchor; anchorTs += ANCHOR_PERIOD_MS) {
      const tteMs = last - anchorTs;
      const tteMins = tteMs / 60_000;
      if (tteMins < TTE_MIN_MINUTES) continue;
      const utcH = new Date(anchorTs).getUTCHours();
      if (!isEligibleHour(utcH)) continue;

      const state = newBookState(m.marketTicker, "");
      for (const ev of m.bookEvents) {
        if (ev.tsMs > anchorTs) break;
        if (ev.type === "snapshot") applySnapshot(state, ev);
        else if (ev.type === "snapshot_terminal") applyTerminalSnapshot(state, ev);
        else applyDelta(state, ev);
      }
      const yb = bestYesBid(state);
      if (yb === null) continue;

      const quote: HypotheticalQuote = {
        marketTicker: m.marketTicker,
        side: SIDE,
        priceDollars: yb,
        sizeContracts: SIZE_CONTRACTS,
        postedAtMs: anchorTs,
        queue: QUEUE_ASSUMPTION,
      };
      const r = simulateQuote(quote, m);

      attempts.push({
        marketTicker: m.marketTicker,
        postedAtMs: anchorTs,
        priceDollars: yb,
        filled: r.filled,
        fillTsMs: r.fillTsMs,
        fillFraction: r.fillFraction,
        collateralIfFilled: yb * r.fillFraction * SIZE_CONTRACTS,
        settlementValue: settlement.value,
        settleAtMs: last,
      });
    }
  }
  attempts.sort((a, b) => a.postedAtMs - b.postedAtMs);
  process.stderr.write(`[${POLICY_NAME} | capped] generated ${attempts.length.toLocaleString()} anchor attempts in ${((Date.now() - tSim) / 1000).toFixed(1)}s\n`);

  // ----- pass 2: chronological cap-enforced walk
  //
  // Event timeline: every POST, FILL, CANCEL, and SETTLE event ordered by
  // ts. Single mutable PortfolioState. POST events check the cap and
  // (if allowed) reserve collateral. FILL converts reservation → open
  // exposure. CANCEL (runway-end of unfilled posts) releases reservation.
  // SETTLE releases open exposure and realizes PnL.

  const state: PortfolioState = {
    bankroll: CAPS.bankrollDollars,
    openExposure: 0,
    reservedExposure: 0,
    openPositions: [],
  };

  const allowed: PostAttempt[] = [];
  const blocked: { attempt: PostAttempt; reason: CapDecisionReason }[] = [];
  const filledPositions: OpenPosition[] = [];

  // For utilization: time-weighted area under (openExposure + reservedExposure)(t).
  // Total locked is what counts against the $5 cap.
  let lastEventTs: number | null = null;
  let exposureTimeIntegral = 0; // dollar-milliseconds of (open + reserved)

  // For drawdown: cash trajectory at SETTLE events.
  const cashTrajectory: { ts: number; bankroll: number }[] = [
    { ts: attempts[0]?.postedAtMs ?? 0, bankroll: state.bankroll },
  ];

  function tickIntegralTo(ts: number): void {
    if (lastEventTs !== null && ts > lastEventTs) {
      exposureTimeIntegral += (state.openExposure + state.reservedExposure) * (ts - lastEventTs);
    }
    lastEventTs = ts;
  }

  // Priority queue of pending FILL / CANCEL / SETTLE events. Sorted insert
  // is fine at this scale (low-hundreds of anchors).
  type PendingKind = "fill" | "cancel" | "settle";
  type Pending = { kind: PendingKind; ts: number; attemptIdx: number };
  const pending: Pending[] = [];
  function insertPending(p: Pending): void {
    let lo = 0, hi = pending.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pending[mid]!.ts <= p.ts) lo = mid + 1;
      else hi = mid;
    }
    pending.splice(lo, 0, p);
  }

  let postCursor = 0;

  function nextEventTs(): number | null {
    const nextPost = postCursor < attempts.length ? attempts[postCursor]!.postedAtMs : null;
    const nextPending = pending.length > 0 ? pending[0]!.ts : null;
    if (nextPost === null && nextPending === null) return null;
    if (nextPost === null) return nextPending;
    if (nextPending === null) return nextPost;
    return Math.min(nextPost, nextPending);
  }

  // Track the worst-case reservation amount per attemptIdx so FILL/CANCEL
  // know how much to release. Same number as decideCapAction used.
  const reservationAt = new Map<number, number>();

  while (true) {
    const tNext = nextEventTs();
    if (tNext === null) break;
    tickIntegralTo(tNext);

    // Drain pending events at this ts before posts. Order within an
    // instant: SETTLE first (frees open exposure), CANCEL next (frees
    // reservation), then FILL (converts reservation to open exposure);
    // POSTs come last so they can use newly freed capacity.
    const order: Record<PendingKind, number> = { settle: 0, cancel: 1, fill: 2 };
    while (pending.length > 0 && pending[0]!.ts === tNext) {
      // pull all same-ts events, sort, then process
      const batch: Pending[] = [];
      while (pending.length > 0 && pending[0]!.ts === tNext) batch.push(pending.shift()!);
      batch.sort((x, y) => order[x.kind] - order[y.kind]);
      for (const p of batch) {
        const a = attempts[p.attemptIdx]!;
        if (p.kind === "fill") {
          const reserved = reservationAt.get(p.attemptIdx) ?? 0;
          state.reservedExposure -= reserved;
          const pos: OpenPosition = {
            marketTicker: a.marketTicker,
            postedAtMs: a.postedAtMs,
            filledAtMs: a.fillTsMs!,
            settleAtMs: a.settleAtMs,
            collateral: a.collateralIfFilled,
            expectedPnl: a.settlementValue === null ? null
              : (a.settlementValue - a.priceDollars) * a.fillFraction * SIZE_CONTRACTS,
          };
          state.openExposure += pos.collateral;
          state.openPositions.push(pos);
          insertPending({ kind: "settle", ts: pos.settleAtMs, attemptIdx: p.attemptIdx });
          reservationAt.delete(p.attemptIdx);
        } else if (p.kind === "cancel") {
          const reserved = reservationAt.get(p.attemptIdx) ?? 0;
          state.reservedExposure -= reserved;
          reservationAt.delete(p.attemptIdx);
        } else {
          // settle
          const posIdx = state.openPositions.findIndex(
            (op) => op.postedAtMs === a.postedAtMs && op.marketTicker === a.marketTicker,
          );
          if (posIdx >= 0) {
            const pos = state.openPositions[posIdx]!;
            state.openExposure -= pos.collateral;
            if (pos.expectedPnl !== null) state.bankroll += pos.expectedPnl;
            state.openPositions.splice(posIdx, 1);
            filledPositions.push(pos);
            cashTrajectory.push({ ts: tNext, bankroll: state.bankroll });
          }
        }
      }
    }

    // Now drain POST events at this ts.
    while (postCursor < attempts.length && attempts[postCursor]!.postedAtMs === tNext) {
      const a = attempts[postCursor]!;
      const quoteCollateral = a.priceDollars * SIZE_CONTRACTS;
      const quote: HypotheticalQuote = {
        marketTicker: a.marketTicker,
        side: SIDE,
        priceDollars: a.priceDollars,
        sizeContracts: SIZE_CONTRACTS,
        postedAtMs: a.postedAtMs,
        queue: QUEUE_ASSUMPTION,
      };
      const decision = decideCapAction(state, quote, CAPS);
      if (decision.kind === "block") {
        blocked.push({ attempt: a, reason: decision.reason });
      } else {
        allowed.push(a);
        state.reservedExposure += quoteCollateral;
        reservationAt.set(postCursor, quoteCollateral);
        if (a.filled && a.fillTsMs !== null) {
          insertPending({ kind: "fill", ts: a.fillTsMs, attemptIdx: postCursor });
        } else {
          // Unfilled: reservation released at runway end.
          insertPending({ kind: "cancel", ts: a.postedAtMs + ANCHOR_RUNWAY_MS, attemptIdx: postCursor });
        }
      }
      postCursor += 1;
    }
  }

  // Force-close any remaining open positions at their settle ts (shouldn't
  // happen if event ordering is correct, but guards against truncated data).
  for (const pos of state.openPositions) {
    state.openExposure -= pos.collateral;
    if (pos.expectedPnl !== null) state.bankroll += pos.expectedPnl;
    filledPositions.push(pos);
    cashTrajectory.push({ ts: pos.settleAtMs, bankroll: state.bankroll });
  }
  state.openPositions.length = 0;
  // Any leftover reservation (data truncation) is also released.
  state.reservedExposure = 0;

  // =====================================================================
  // METRICS
  // =====================================================================

  const totalPosted = attempts.length;
  const totalAllowed = allowed.length;
  const totalBlocked = blocked.length;
  const blockedByReason: Record<CapDecisionReason, number> = {
    quote_size_cap: 0, exposure_cap: 0, bankroll_exhausted: 0,
  };
  for (const b of blocked) blockedByReason[b.reason] += 1;

  const allowedFilled = allowed.filter((a) => a.filled);
  const allowedFilledWithSettlement = filledPositions.filter((p) => p.expectedPnl !== null);
  const realizedPnl = state.bankroll - CAPS.bankrollDollars;
  const evPerAllowedPosted = totalAllowed > 0 ? realizedPnl / totalAllowed : 0;
  const evPerAllowedFilled = allowedFilledWithSettlement.length > 0
    ? realizedPnl / allowedFilledWithSettlement.length
    : 0;

  // Max drawdown: max running peak − current bankroll across cashTrajectory.
  let peak = CAPS.bankrollDollars;
  let maxDD = 0;
  for (const c of cashTrajectory) {
    if (c.bankroll > peak) peak = c.bankroll;
    const dd = peak - c.bankroll;
    if (dd > maxDD) maxDD = dd;
  }

  // Capital utilization: average openExposure / maxOpenExposureDollars over
  // the active window (first post ts → last settle ts).
  const tStart = attempts.length > 0 ? attempts[0]!.postedAtMs : 0;
  const tEnd = filledPositions.length > 0
    ? Math.max(...filledPositions.map((p) => p.settleAtMs))
    : tStart;
  const activeMs = Math.max(1, tEnd - tStart);
  const avgExposure = exposureTimeIntegral / activeMs;
  const utilization = avgExposure / CAPS.maxOpenExposureDollars;

  // Exposure duration: avg(settleTs − filledAtMs) across filled positions.
  const durations = filledPositions.map((p) => p.settleAtMs - p.filledAtMs);
  const avgDurationMs = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;
  const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0;

  // =====================================================================
  // REPORT
  // =====================================================================

  console.log();
  console.log(`# ${POLICY_NAME} — capped replay — \`${args.label}\``);
  console.log();
  console.log("> **REPLAY-ONLY CAPITAL CAP MODE.** No live orders, no worker changes, no");
  console.log("> ledger edits. This is NOT validation. Official validation still requires a");
  console.log("> distinct-week holdout with `continuous_holdout_eligible: true` and the");
  console.log(`> uncapped \`${POLICY_NAME}\` replay clearing its 7 pre-registered gates.`);
  console.log();
  console.log(`- Policy: ${POLICY_NAME} (constants mirrored — see file header)`);
  console.log(`- Pre-registration: ${PREREG_DOC}`);
  console.log(`- Log dir: ${args.logDir}`);
  console.log(`- Markets indexed: ${idx.size}`);
  console.log();
  console.log("## Capital envelope under test");
  console.log();
  console.log("| cap | value |");
  console.log("|---|---:|");
  console.log(`| bankroll | $${CAPS.bankrollDollars.toFixed(2)} |`);
  console.log(`| max quote size | $${CAPS.maxQuoteSizeDollars.toFixed(2)} |`);
  console.log(`| max simultaneous exposure | $${CAPS.maxOpenExposureDollars.toFixed(2)} |`);
  console.log();

  console.log("## Cap admission");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| anchors generated by frozen policy | ${totalPosted.toLocaleString()} |`);
  console.log(`| allowed by cap | ${totalAllowed.toLocaleString()} (${pct(totalAllowed, totalPosted)}) |`);
  console.log(`| blocked by cap | ${totalBlocked.toLocaleString()} (${pct(totalBlocked, totalPosted)}) |`);
  console.log(`| — blocked: quote_size_cap | ${blockedByReason.quote_size_cap.toLocaleString()} |`);
  console.log(`| — blocked: exposure_cap | ${blockedByReason.exposure_cap.toLocaleString()} |`);
  console.log(`| — blocked: bankroll_exhausted | ${blockedByReason.bankroll_exhausted.toLocaleString()} |`);
  console.log(`| allowed & filled | ${allowedFilled.length.toLocaleString()} (${pct(allowedFilled.length, totalAllowed)} of allowed) |`);
  console.log();

  console.log("## P&L under cap");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| starting bankroll | $${CAPS.bankrollDollars.toFixed(4)} |`);
  console.log(`| ending bankroll | $${state.bankroll.toFixed(4)} |`);
  console.log(`| realized PnL | ${sign(realizedPnl)}$${Math.abs(realizedPnl).toFixed(4)} |`);
  console.log(`| EV per allowed posted | ${sign(evPerAllowedPosted)}$${Math.abs(evPerAllowedPosted).toFixed(4)} |`);
  console.log(`| EV per allowed filled | ${sign(evPerAllowedFilled)}$${Math.abs(evPerAllowedFilled).toFixed(4)} |`);
  console.log(`| max drawdown | $${maxDD.toFixed(4)} |`);
  console.log();

  console.log("## Capital utilization");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| active window | ${(activeMs / 3_600_000).toFixed(2)} h |`);
  console.log(`| time-avg locked (open + reserved) | $${avgExposure.toFixed(4)} |`);
  console.log(`| utilization (avg locked / max-exposure-cap) | ${(utilization * 100).toFixed(1)}% |`);
  console.log();

  console.log("## Exposure duration (per filled position)");
  console.log();
  console.log("| metric | value |");
  console.log("|---|---:|");
  console.log(`| filled positions | ${filledPositions.length.toLocaleString()} |`);
  console.log(`| mean duration | ${(avgDurationMs / 1000).toFixed(1)} s |`);
  console.log(`| max duration | ${(maxDurationMs / 1000).toFixed(1)} s |`);
  console.log();

  console.log("## Reading this report");
  console.log();
  console.log("- A high **exposure_cap** block count is the signal you are hitting the $5");
  console.log("  ceiling and parallel anchors are stacking — informs whether $5 is a binding");
  console.log("  constraint at this anchor cadence.");
  console.log("- A nonzero **bankroll_exhausted** count means realized losses are eroding");
  console.log("  available capacity (only possible after settled losses).");
  console.log("- **utilization** is the time-weighted occupancy of the $5 cap. Low % with");
  console.log("  many exposure_cap blocks indicates burstiness — fills cluster in time.");
  console.log("- **max drawdown** is realized-only, computed from the cash trajectory at");
  console.log("  SETTLE events (no mark-to-market dips during the life of a position).");
  console.log();
  console.log("This run is for envelope characterization and live-canary design. It does NOT");
  console.log("substitute for the official holdout validation.");
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  return `${((100 * num) / den).toFixed(1)}%`;
}
function sign(n: number): string { return n >= 0 ? "+" : "-"; }

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
