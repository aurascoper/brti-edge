export type ScoreStatus = "promote" | "active" | "quiet";

export function statusForScore(score: number | null | undefined): ScoreStatus {
  if (score === null || score === undefined || !Number.isFinite(score)) return "quiet";
  if (score > 0.85) return "promote";
  if (score >= 0.65) return "active";
  return "quiet";
}

export const STATUS_LABEL: Record<ScoreStatus, string> = {
  promote: "promote candidate",
  active: "active",
  quiet: "quiet",
};

export const STATUS_DOT: Record<ScoreStatus, string> = {
  promote: "bg-cyan-300",
  active: "bg-emerald-400",
  quiet: "bg-zinc-500",
};

export const STATUS_TEXT: Record<ScoreStatus, string> = {
  promote: "text-cyan-200",
  active: "text-emerald-300",
  quiet: "text-zinc-400",
};
