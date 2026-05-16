import type { Decision, DecisionInput, Strategy } from "./types";

// Variant of fairValueArb that clamps the model's fair_YES into [0.35, 0.65].
//
// Hypothesis: the original fairValueArb shows non-monotonic PnL by edge bucket,
// with the largest-edge trades (0.080+) producing the worst realized PnL.
// This suggests the log-normal model over-extrapolates when BTC has moved a lot
// in the realized-vol window (vol mean-reverts; Polymarket may already reflect
// the move; large model edges are illusory).
//
// The cap removes the longest-tail predictions entirely. It is the minimum-
// intervention test to isolate whether model extremeness explains the loss
// in the high-edge bucket. All other parameters identical to fairValueArb.

const SECONDS_PER_YEAR = 365 * 24 * 3600;
const DEFAULT_SIZE = 2;
const SAFETY_BUFFER = 0.005;
const EDGE_FLOOR = 0.0075;
const FAIR_MIN = 0.35;
const FAIR_MAX = 0.65;

export const fairValueArbCapped: Strategy = {
  name: "fairValueArbCapped",
  decide(input: DecisionInput): Decision {
    const { sRef, sCurrent, sigmaAnnual, midYes, bestBidYes, bestAskYes, endDateMs, nowMs } =
      input;

    if (sRef === null || sCurrent === null || sigmaAnnual === null || sigmaAnnual <= 0) {
      return { side: "SKIP", size: 0, price: null, reason: "no_sref_or_sigma" };
    }
    if (midYes === null || bestBidYes === null || bestAskYes === null) {
      return { side: "SKIP", size: 0, price: null, reason: "no_book" };
    }
    const dtSec = (endDateMs - nowMs) / 1000;
    if (dtSec <= 0) return { side: "SKIP", size: 0, price: null, reason: "expired" };
    if (dtSec > 24 * 3600) {
      return { side: "SKIP", size: 0, price: null, reason: "horizon_too_long" };
    }

    const dtYears = dtSec / SECONDS_PER_YEAR;
    const stdev = sigmaAnnual * Math.sqrt(dtYears);
    if (stdev <= 0) return { side: "SKIP", size: 0, price: null, reason: "zero_stdev" };

    const logRet = Math.log(sCurrent / sRef);
    const z = logRet / stdev;
    const fairYesRaw = normalCdf(z);
    const fairYes = Math.max(FAIR_MIN, Math.min(FAIR_MAX, fairYesRaw));
    const clamped = fairYes !== fairYesRaw;

    const halfSpread = (bestAskYes - bestBidYes) / 2;
    const threshold = halfSpread + SAFETY_BUFFER + EDGE_FLOOR;

    const yesEdge = fairYes - bestAskYes;
    const noPrice = 1 - bestBidYes;
    const noEdge = 1 - fairYes - noPrice;

    const clampTag = clamped ? `_clamped_from=${fairYesRaw.toFixed(3)}` : "";

    if (yesEdge > threshold) {
      return {
        side: "YES",
        size: DEFAULT_SIZE,
        price: bestAskYes,
        reason: `fair=${fairYes.toFixed(3)}_edge=${yesEdge.toFixed(3)}_hs=${halfSpread.toFixed(3)}${clampTag}`,
      };
    }
    if (noEdge > threshold) {
      return {
        side: "NO",
        size: DEFAULT_SIZE,
        price: noPrice,
        reason: `fair=${fairYes.toFixed(3)}_noEdge=${noEdge.toFixed(3)}_hs=${halfSpread.toFixed(3)}${clampTag}`,
      };
    }
    return {
      side: "SKIP",
      size: 0,
      price: null,
      reason: `fair=${fairYes.toFixed(3)}_mid=${midYes.toFixed(3)}_hs=${halfSpread.toFixed(3)}_no_edge${clampTag}`,
    };
  },
};

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
