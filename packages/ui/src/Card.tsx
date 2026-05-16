import * as React from "react";

export interface CardProps {
  title?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function Card({ title, right, children, className = "" }: CardProps) {
  return (
    <section
      className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 ${className}`}
    >
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wider text-zinc-400">
          <span>{title}</span>
          {right}
        </header>
      )}
      <div className="flex-1 overflow-hidden p-3">{children}</div>
    </section>
  );
}
