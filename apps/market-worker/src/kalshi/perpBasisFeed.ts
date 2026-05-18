// Spot-perp basis poller for the Layer-2 shadow bakeoff.
//
// Polls a perp-futures venue (default: Kraken Futures — US-licensed and
// covers BTC/ETH/SOL/BNB/DOGE/XRP/HYPE/BCH/ADA at PF_{ASSET}USD; Bybit
// blocks US IPs; Binance Global futures also blocks US; Binance.US has
// no futures product) at ~3s cadence and caches the latest mark/index/
// funding per symbol. Pure read-only, no auth.
//
// Used by modelBakeoffLogger to compute:
//   basis_mid = perp_mark - brti_spot
//   basis_bps = 10000 * basis_mid / brti_spot
// and to surface lastFundingRate as a separate scalar feature.
//
// Symbol-mapping convention: callers pass a BRTI-style underlying ("BTC",
// "ETH", ...) and the feed maps to the venue's perp ticker. Kraken uses
// XBT instead of BTC, so PF_XBTUSD; all others are PF_{ASSET}USD.

import type { Symbol } from "../brti/types";

const PERP_REST = process.env.PERP_FEED_REST ?? "https://futures.kraken.com";
const PERP_TICKERS_PATH = process.env.PERP_FEED_PATH ?? "/derivatives/api/v3/tickers";

export interface PerpTick {
  ts_ms: number;
  mark: number;
  index: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  fundingRate: number | null;
}

interface KrakenFuturesTicker {
  symbol: string;
  markPrice?: number;
  indexPrice?: number;
  last?: number;
  bid?: number;
  ask?: number;
  fundingRate?: number;
}

function num(v: number | string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function krakenSymbol(asset: Symbol): string {
  // Kraken uses legacy "XBT" for BTC; everything else is straight-through.
  const a = asset === "BTC" ? "XBT" : asset;
  return `PF_${a}USD`;
}

export class PerpBasisFeed {
  private readonly symbols: Symbol[];
  private readonly ticks: Map<Symbol, PerpTick> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(symbols: Symbol[]) {
    this.symbols = symbols;
  }

  async start(intervalMs = 3_000): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.pollAll();
    this.intervalId = setInterval(() => {
      void this.pollAll();
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getTick(sym: Symbol): PerpTick | null {
    return this.ticks.get(sym) ?? null;
  }

  // Convenience: basis vs caller-provided spot (typically BRTI mean).
  // Returns null if perp data is stale or spot is invalid.
  getBasis(sym: Symbol, spotPrice: number | null, staleMsMax = 10_000): {
    basis_mid: number | null;
    basis_bps: number | null;
    perp_mark: number | null;
    perp_index: number | null;
    fundingRate: number | null;
    perp_age_ms: number | null;
  } {
    const empty = {
      basis_mid: null,
      basis_bps: null,
      perp_mark: null,
      perp_index: null,
      fundingRate: null,
      perp_age_ms: null,
    };
    const t = this.ticks.get(sym);
    if (!t) return empty;
    const age = Date.now() - t.ts_ms;
    if (age > staleMsMax) return { ...empty, perp_age_ms: age };
    if (spotPrice === null || !Number.isFinite(spotPrice) || spotPrice <= 0) {
      return {
        basis_mid: null,
        basis_bps: null,
        perp_mark: t.mark,
        perp_index: t.index,
        fundingRate: t.fundingRate,
        perp_age_ms: age,
      };
    }
    const basis_mid = t.mark - spotPrice;
    const basis_bps = 10_000 * basis_mid / spotPrice;
    return {
      basis_mid,
      basis_bps,
      perp_mark: t.mark,
      perp_index: t.index,
      fundingRate: t.fundingRate,
      perp_age_ms: age,
    };
  }

  private async pollAll(): Promise<void> {
    // Single batch call: /derivatives/api/v3/tickers returns ALL Kraken
    // Futures contracts (perps + dated). We filter to our PF_*USD perps
    // client-side. Cheaper than N parallel single-symbol calls.
    try {
      const url = `${PERP_REST}${PERP_TICKERS_PATH}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const body = (await res.json()) as {
        result?: string;
        tickers?: KrakenFuturesTicker[];
      };
      if (body.result !== "success") return;
      const list = body.tickers ?? [];
      const now = Date.now();
      const wanted = new Map<string, Symbol>();
      for (const s of this.symbols) wanted.set(krakenSymbol(s), s);
      for (const row of list) {
        const sym = wanted.get(row.symbol);
        if (!sym) continue;
        const mark = num(row.markPrice);
        const index = num(row.indexPrice);
        if (mark === null) continue;
        this.ticks.set(sym, {
          ts_ms: now,
          mark,
          index: index ?? mark,
          last: num(row.last),
          bid: num(row.bid),
          ask: num(row.ask),
          fundingRate: num(row.fundingRate),
        });
      }
    } catch {
      // network blip — keep last good values; staleness is enforced at read time
    }
  }
}
