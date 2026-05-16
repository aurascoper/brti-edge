import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionInput, DecisionRow, Strategy } from "./types";

export class ShadowLogger {
  private seen = new Set<string>();

  constructor(
    private readonly strategies: Strategy[],
    private readonly file: string,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.hydrateSeen();
  }

  private hydrateSeen(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, "utf8");
      let restored = 0;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line) as { marketId?: string };
          if (row.marketId) {
            this.seen.add(row.marketId);
            restored++;
          }
        } catch {}
      }
      if (restored > 0) {
        console.log(`[shadow] hydrated ${restored} seen marketIds from ${this.file}`);
      }
    } catch (err) {
      console.warn("[shadow] hydrate failed", err);
    }
  }

  fire(input: DecisionInput): DecisionRow | null {
    if (this.seen.has(input.marketId)) return null;
    this.seen.add(input.marketId);

    const decisions: Record<string, ReturnType<Strategy["decide"]>> = {};
    for (const s of this.strategies) {
      decisions[s.name] = s.decide(input);
    }
    const spreadBps =
      input.bestAskYes !== null && input.bestBidYes !== null
        ? (input.bestAskYes - input.bestBidYes) * 10_000
        : null;

    const row: DecisionRow = {
      ts: new Date(input.nowMs).toISOString(),
      marketId: input.marketId,
      marketSlug: input.marketSlug,
      endDate: new Date(input.endDateMs).toISOString(),
      tStart: input.tStartMs !== null ? new Date(input.tStartMs).toISOString() : null,
      secsToExpiry: Math.max(0, (input.endDateMs - input.nowMs) / 1000),
      midYes: input.midYes,
      bestBidYes: input.bestBidYes,
      bestAskYes: input.bestAskYes,
      spreadBps,
      bookAgeSec: input.bookAgeSec,
      btcRef: input.btcRef,
      sRef: input.sRef,
      sCurrent: input.sCurrent,
      sigmaAnnual: input.sigmaAnnual,
      decisions,
    };

    try {
      appendFileSync(this.file, JSON.stringify(row) + "\n");
    } catch (err) {
      console.warn("[shadow] append failed", err);
    }

    const tags = Object.entries(decisions)
      .map(([n, d]) => `${n}=${d.side}${d.side !== "SKIP" ? ":" + d.reason : ""}`)
      .join(" | ");
    console.log(
      `[shadow] ${input.marketSlug.slice(0, 38)} ` +
        `mid=${input.midYes?.toFixed(3) ?? "—"} ` +
        `Δexp=${(row.secsToExpiry / 60).toFixed(1)}m | ${tags}`,
    );
    return row;
  }
}
