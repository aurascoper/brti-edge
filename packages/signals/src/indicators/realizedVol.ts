export function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1];
    const b = prices[i];
    if (a && b && a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

export function realizedVol(prices: number[], samplesPerYear = 525_600): number {
  const r = logReturns(prices);
  if (r.length < 2) return 0;
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance * samplesPerYear);
}
