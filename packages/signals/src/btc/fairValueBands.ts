export interface UpDownThresholdMarket {
  threshold: number;
  direction: "up" | "down";
  endTs: number;
  refTs: number;
  refPrice: number;
}

export function fairValueProb(
  spot: number,
  vol: number,
  market: UpDownThresholdMarket,
  now = Date.now(),
): number | null {
  const tToEnd = (market.endTs - now) / 31_557_600_000;
  if (tToEnd <= 0 || !Number.isFinite(vol) || vol <= 0 || spot <= 0) return null;
  const drift = -0.5 * vol * vol * tToEnd;
  const stdev = vol * Math.sqrt(tToEnd);
  const z = (Math.log(market.threshold / spot) - drift) / stdev;
  const pAbove = 1 - normCdf(z);
  return market.direction === "up" ? pAbove : 1 - pAbove;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
