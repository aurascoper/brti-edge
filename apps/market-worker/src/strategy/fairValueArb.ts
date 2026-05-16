import type { Decision, DecisionInput, Strategy } from "./types";

// Strategy: Polymarket vs CEX-implied fair value (log-normal model).
//
// For a "Will BTC be up from T_start to T_end?" binary, with current time t and BTC
// spot S(t), assuming Brownian dynamics with drift μ≈0 and annualized vol σ:
//
//   fair_YES(t) = Φ( ln(S(t)/S_ref) / (σ · √Δt_remaining_years) )
//
// Trade rule:
//   if fair_YES − bestAskYes > halfSpread + safety + edge_floor → BUY YES
//   if (1 − fair_YES) − bestAskNo > halfSpread + safety + edge_floor → BUY NO
//   else SKIP
//
// where bestAskNo = 1 − bestBidYes.

const SECONDS_PER_YEAR = 365 * 24 * 3600;
const DEFAULT_SIZE = 2;
const SAFETY_BUFFER = 0.005; // 50 bps
const EDGE_FLOOR = 0.0075; // 75 bps min edge after spread + safety

export const fairValueArb: Strategy = {
  name: "fairValueArb",
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
    const fairYes = normalCdf(z);

    const halfSpread = (bestAskYes - bestBidYes) / 2;
    const threshold = halfSpread + SAFETY_BUFFER + EDGE_FLOOR;

    const yesEdge = fairYes - bestAskYes;
    const noPrice = 1 - bestBidYes;
    const noEdge = 1 - fairYes - noPrice;

    if (yesEdge > threshold) {
      return {
        side: "YES",
        size: DEFAULT_SIZE,
        price: bestAskYes,
        reason: `fair=${fairYes.toFixed(3)}_edge=${yesEdge.toFixed(3)}_hs=${halfSpread.toFixed(3)}`,
      };
    }
    if (noEdge > threshold) {
      return {
        side: "NO",
        size: DEFAULT_SIZE,
        price: noPrice,
        reason: `fair=${fairYes.toFixed(3)}_noEdge=${noEdge.toFixed(3)}_hs=${halfSpread.toFixed(3)}`,
      };
    }
    return {
      side: "SKIP",
      size: 0,
      price: null,
      reason: `fair=${fairYes.toFixed(3)}_mid=${midYes.toFixed(3)}_hs=${halfSpread.toFixed(3)}_no_edge`,
    };
  },
};

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz–Stegun 7.1.26
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
