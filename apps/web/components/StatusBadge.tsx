"use client";

import { STATUS_DOT, STATUS_LABEL, STATUS_TEXT, type ScoreStatus } from "../lib/status";

export function StatusBadge({ status }: { status: ScoreStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_TEXT[status]}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}
