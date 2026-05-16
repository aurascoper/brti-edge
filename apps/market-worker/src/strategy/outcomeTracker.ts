import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchMarkets } from "@polyterminal/polymarket-client";
import type { Decision, DecisionRow, OutcomeRow } from "./types";

const GRACE_MS = 60_000;

export class OutcomeTracker {
  private pending = new Map<string, DecisionRow>();
  private resolved = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly decisionsFile?: string,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.hydrate();
  }

  private hydrate(): void {
    if (existsSync(this.file)) {
      try {
        const raw = readFileSync(this.file, "utf8");
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const row = JSON.parse(line) as { marketId?: string };
            if (row.marketId) this.resolved.add(row.marketId);
          } catch {}
        }
      } catch (err) {
        console.warn("[outcome] hydrate outcomes failed", err);
      }
    }
    if (this.decisionsFile && existsSync(this.decisionsFile)) {
      try {
        const raw = readFileSync(this.decisionsFile, "utf8");
        let restored = 0;
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const row = JSON.parse(line) as DecisionRow;
            if (!row.marketId || this.resolved.has(row.marketId)) continue;
            this.pending.set(row.marketId, row);
            restored++;
          } catch {}
        }
        if (restored > 0) {
          console.log(
            `[outcome] hydrated ${restored} pending markets (${this.resolved.size} already resolved)`,
          );
        }
      } catch (err) {
        console.warn("[outcome] hydrate decisions failed", err);
      }
    }
  }

  add(row: DecisionRow): void {
    if (this.resolved.has(row.marketId)) return;
    this.pending.set(row.marketId, row);
  }

  size(): number {
    return this.pending.size;
  }

  async resolveDue(nowMs: number): Promise<OutcomeRow[]> {
    const due: DecisionRow[] = [];
    for (const row of this.pending.values()) {
      const expiry = Date.parse(row.endDate);
      if (Number.isFinite(expiry) && nowMs >= expiry + GRACE_MS) due.push(row);
    }
    if (due.length === 0) return [];

    let markets: Awaited<ReturnType<typeof fetchMarkets>>;
    try {
      markets = await fetchMarkets({
        conditionIds: due.map((r) => r.marketId),
        closed: true,
      });
    } catch (err) {
      console.warn("[outcome] fetchMarkets failed", err);
      return [];
    }
    const byId = new Map(markets.map((m) => [m.conditionId, m]));

    const outcomes: OutcomeRow[] = [];
    for (const row of due) {
      const m = byId.get(row.marketId);
      if (!m || !m.closed) continue;
      let resolvedYes: 0 | 1;
      try {
        const prices = JSON.parse(m.outcomePrices) as string[];
        const yesPrice = Number(prices[0]);
        if (!Number.isFinite(yesPrice)) continue;
        resolvedYes = yesPrice >= 0.5 ? 1 : 0;
      } catch {
        continue;
      }

      const pnlByStrategy: Record<string, number> = {};
      for (const [name, decision] of Object.entries(row.decisions) as [string, Decision][]) {
        pnlByStrategy[name] = pnlFor(decision, resolvedYes);
      }

      const outcomeRow: OutcomeRow = {
        ts: new Date(nowMs).toISOString(),
        marketId: row.marketId,
        marketSlug: row.marketSlug,
        resolvedYes,
        pnlByStrategy,
        decision: row,
      };
      try {
        appendFileSync(this.file, JSON.stringify(outcomeRow) + "\n");
      } catch (err) {
        console.warn("[outcome] append failed", err);
      }
      outcomes.push(outcomeRow);
      this.pending.delete(row.marketId);
      this.resolved.add(row.marketId);
    }

    if (outcomes.length > 0) {
      const summary = outcomes
        .map((o) => {
          const tag = Object.entries(o.pnlByStrategy)
            .map(([n, p]) => `${n}=${p.toFixed(2)}`)
            .join(" ");
          return `${o.marketSlug.slice(0, 36)} → YES=${o.resolvedYes} | ${tag}`;
        })
        .join("\n  ");
      console.log(`[outcome] resolved ${outcomes.length}:\n  ${summary}`);
    }
    return outcomes;
  }
}

function pnlFor(decision: Decision, resolvedYes: 0 | 1): number {
  if (decision.side === "SKIP" || decision.price === null) return 0;
  const sideWonYes = decision.side === "YES" ? 1 : 0;
  const won = sideWonYes === resolvedYes;
  return won ? (1 - decision.price) * decision.size : -decision.price * decision.size;
}
