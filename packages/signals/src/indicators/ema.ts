export function ema(values: number[], span: number): number[] {
  if (span <= 0) throw new Error("span must be > 0");
  const alpha = 2 / (span + 1);
  const out: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    if (!Number.isFinite(v)) {
      out.push(prev ?? Number.NaN);
      continue;
    }
    prev = prev === null ? v : prev + alpha * (v - prev);
    out.push(prev);
  }
  return out;
}
