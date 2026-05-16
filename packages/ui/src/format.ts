export function formatPrice(p: number | null | undefined, digits = 4): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return p.toFixed(digits);
}

export function formatSize(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  if (s >= 1e6) return `${(s / 1e6).toFixed(2)}M`;
  if (s >= 1e3) return `${(s / 1e3).toFixed(2)}k`;
  return s.toFixed(2);
}

export function formatPct(p: number | null | undefined, digits = 2): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(digits)}%`;
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
