import * as React from "react";

export interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "up" | "down";
}

export function Stat({ label, value, hint, tone = "default" }: StatProps) {
  const toneClass =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-zinc-100";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`font-mono text-base ${toneClass}`}>{value}</span>
      {hint && <span className="text-[10px] text-zinc-500">{hint}</span>}
    </div>
  );
}
