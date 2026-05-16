import type { DecisionRow } from "../strategy/types";
import type { DustPolicyConfig, DustState, PolicyDecision } from "./types";

export function loadPolicyFromEnv(): DustPolicyConfig {
  const num = (k: string, d: number) => {
    const v = process.env[k];
    if (!v) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const list = (k: string, d: string[]) => (process.env[k] ? process.env[k]!.split(",") : d);
  return {
    enabled: process.env.POLYTERMINAL_DUST_ENABLED === "1",
    live: process.env.POLYTERMINAL_DUST_LIVE === "1",
    strategiesAllowed: list("POLYTERMINAL_DUST_STRATEGIES", ["fairValueArb"]),
    sidesAllowed: list("POLYTERMINAL_DUST_SIDES", ["NO"]) as ("YES" | "NO")[],
    horizonsAllowed: list("POLYTERMINAL_DUST_HORIZONS", ["5m"]) as ("5m" | "15m" | "other")[],
    maxNotionalUsd: num("POLYTERMINAL_DUST_MAX_NOTIONAL", 1),
    maxTradesTotal: num("POLYTERMINAL_DUST_MAX_TRADES", 5),
    manualConfirmFirstN: num("POLYTERMINAL_DUST_MANUAL_CONFIRM_FIRST_N", 3),
    hardStopPnl: num("POLYTERMINAL_DUST_HARD_STOP_PNL", -2),
    maxBtcDriftBps: num("POLYTERMINAL_DUST_MAX_DRIFT_BPS", 30),
    freshnessMaxSec: num("POLYTERMINAL_DUST_FRESHNESS_MAX_SEC", 5),
    candidateTtlSec: num("POLYTERMINAL_DUST_CANDIDATE_TTL_SEC", 60),
    minOrderSize: num("POLYTERMINAL_DUST_MIN_ORDER_SIZE", 5),
  };
}

export interface EvaluateInput {
  strategyName: string;
  row: DecisionRow;
  config: DustPolicyConfig;
  state: DustState;
}

export function evaluate(input: EvaluateInput): PolicyDecision {
  const reasons: string[] = [];
  const { strategyName, row, config, state } = input;

  if (!config.enabled) reasons.push("kill_switch_disabled");
  if (!config.strategiesAllowed.includes(strategyName)) {
    reasons.push(`strategy=${strategyName}_not_allowed`);
  }

  const d = row.decisions[strategyName];
  if (!d || d.side === "SKIP" || d.price === null) {
    return { approved: false, reasons: ["no_actionable_decision"], cappedSize: 0, requiresManualConfirm: false };
  }
  if (!config.sidesAllowed.includes(d.side as "YES" | "NO")) {
    reasons.push(`side=${d.side}_not_allowed`);
  }
  const horizon = horizonFromSlug(row.marketSlug);
  if (!config.horizonsAllowed.includes(horizon)) {
    reasons.push(`horizon=${horizon}_not_allowed`);
  }
  if (state.tradesSubmittedTotal >= config.maxTradesTotal) {
    reasons.push(`trades_count=${state.tradesSubmittedTotal}>=max=${config.maxTradesTotal}`);
  }
  if (state.cumulativePnl <= config.hardStopPnl) {
    reasons.push(`cumulative_pnl=${state.cumulativePnl}<=hard_stop=${config.hardStopPnl}`);
  }
  if (state.inFlightId) {
    reasons.push(`order_in_flight=${state.inFlightId}`);
  }
  if (row.bookAgeSec !== null && row.bookAgeSec > config.freshnessMaxSec) {
    reasons.push(`book_age_sec=${row.bookAgeSec.toFixed(1)}>max=${config.freshnessMaxSec}`);
  }

  // Regime guard: skip if BTC has drifted far from S_ref at decision time
  if (row.sRef && row.sCurrent && row.sRef > 0 && row.sCurrent > 0) {
    const driftBps = Math.abs(Math.log(row.sCurrent / row.sRef)) * 10_000;
    if (driftBps > config.maxBtcDriftBps) {
      reasons.push(`btc_drift_bps=${driftBps.toFixed(1)}>max=${config.maxBtcDriftBps}`);
    }
  }

  // Size resolution: enforce both Polymarket's per-market minimum (orderMinSize,
  // typically 5 for 5m BTC up/down markets) and our notional ceiling.
  // Strategy's d.size is a suggestion; final size must satisfy:
  //   minSize ≤ size, size * price ≤ maxNotionalUsd
  // If those conflict, reject — the market is structurally outside our cap.
  const minSize = config.minOrderSize;
  let cappedSize = Math.max(d.size, minSize);
  if (cappedSize * d.price > config.maxNotionalUsd) {
    if (minSize * d.price > config.maxNotionalUsd) {
      reasons.push(
        `min_order_size=${minSize}*price=${d.price.toFixed(3)}>max_notional=${config.maxNotionalUsd}`,
      );
    } else {
      cappedSize = Math.floor((config.maxNotionalUsd / d.price) * 100) / 100;
      if (cappedSize < minSize) {
        reasons.push(
          `size_floor=${minSize}_capped_to=${cappedSize}_at_price=${d.price.toFixed(3)}`,
        );
      }
    }
  }
  if (cappedSize <= 0) reasons.push(`size_caps_to_zero_at_price=${d.price}`);

  const approved = reasons.length === 0;
  const requiresManualConfirm =
    approved && state.tradesSubmittedTotal < config.manualConfirmFirstN;

  return { approved, reasons, cappedSize, requiresManualConfirm };
}

function horizonFromSlug(slug: string): "5m" | "15m" | "other" {
  if (slug.includes("btc-updown-5m")) return "5m";
  if (slug.includes("btc-updown-15m")) return "15m";
  return "other";
}
