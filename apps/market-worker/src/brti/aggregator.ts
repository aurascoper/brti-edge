// Synthetic-BRTI aggregator.
//
// Subscribes to constituent venue feeds, maintains per-venue rolling tick
// state, and emits a 1-second benchmark snapshot computed as a robust
// trimmed mean of constituent mid prices. Maintains rolling logs for σ
// estimation and OFI feature extraction.
//
// Phase 1 (this file): Coinbase + Kraken + Bitstamp via REST polling.
// Phase 2 deferred: Gemini, itBit, Bullish, Crypto.com WebSocket feeds.
//
// Usage (worker integration):
//   const brti = new BrtiAggregator(["BTC", "ETH", "SOL", "DOGE", "XRP"]);
//   await brti.start();
//   const snap = brti.getSnapshot("BTC");     // latest 1s benchmark
//   const sigma = brti.getSigmaAnnual("BTC"); // rolling realized vol
//   const ofi = brti.getOfi("BTC");           // OFI features

import type { BrtiSnapshot, OfiFeatures, Symbol, VenueAdapter, VenueTick } from "./types";
import { CoinbaseAdapter } from "./venues/coinbase";
import { KrakenAdapter } from "./venues/kraken";
import { BitstampAdapter } from "./venues/bitstamp";

const TICK_STALE_MS = 5000;        // drop ticks older than this from snapshot
const SNAPSHOT_INTERVAL_MS = 1000; // emit one snapshot per second
const PRICE_BUFFER_SIZE = 3600;    // 1 hour of 1s snapshots for σ estimation

export class BrtiAggregator {
  private symbols: Symbol[];
  private adapters: VenueAdapter[];

  // latest tick per venue × symbol
  private ticks: Map<string, VenueTick> = new Map();
  // rolling 1s benchmark snapshots per symbol
  private snapshots: Map<Symbol, BrtiSnapshot[]> = new Map();
  // 1s log-return buffer for σ estimation
  private logReturns: Map<Symbol, number[]> = new Map();
  private lastSnapshotPrice: Map<Symbol, number> = new Map();

  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(symbols: Symbol[]) {
    this.symbols = symbols;
    this.adapters = [
      new CoinbaseAdapter(symbols),
      new KrakenAdapter(symbols),
      new BitstampAdapter(symbols),
    ];
    for (const s of symbols) {
      this.snapshots.set(s, []);
      this.logReturns.set(s, []);
    }
  }

  async start(): Promise<void> {
    for (const a of this.adapters) {
      await a.start((t) => this.onTick(t));
    }
    this.snapshotTimer = setInterval(() => this.emitSnapshots(), SNAPSHOT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    for (const a of this.adapters) await a.stop();
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  private onTick(t: VenueTick): void {
    this.ticks.set(`${t.venue}:${t.symbol}`, t);
  }

  // Robust trimmed-mean aggregator. With N venues:
  //   N >= 5: drop top and bottom 1, mean of remaining
  //   N == 3-4: mean of all
  //   N <= 2: mean of all (degraded — will flag low confidence)
  private emitSnapshots(): void {
    const now = Date.now();
    for (const sym of this.symbols) {
      const contributing: Array<{ venue: string; mid: number }> = [];
      for (const a of this.adapters) {
        const t = this.ticks.get(`${a.venue}:${sym}`);
        if (!t) continue;
        if (now - t.ts_ms > TICK_STALE_MS) continue;
        const mid = (t.bid + t.ask) / 2;
        if (Number.isFinite(mid) && mid > 0) {
          contributing.push({ venue: t.venue, mid });
        }
      }
      if (contributing.length === 0) continue;

      const sorted = [...contributing].sort((a, b) => a.mid - b.mid);
      let kept = sorted;
      if (sorted.length >= 5) kept = sorted.slice(1, -1);
      const price = kept.reduce((s, c) => s + c.mid, 0) / kept.length;
      const raw_mids: Record<string, number> = {};
      for (const c of contributing) raw_mids[c.venue] = c.mid;

      const snap: BrtiSnapshot = {
        symbol: sym,
        price,
        ts_ms: now,
        contributors: kept.map((c) => c.venue),
        raw_mids,
      };

      // update log-return for σ
      const last = this.lastSnapshotPrice.get(sym);
      if (last !== undefined && last > 0) {
        const r = Math.log(price / last);
        const buf = this.logReturns.get(sym)!;
        buf.push(r);
        if (buf.length > PRICE_BUFFER_SIZE) buf.shift();
      }
      this.lastSnapshotPrice.set(sym, price);

      const sbuf = this.snapshots.get(sym)!;
      sbuf.push(snap);
      if (sbuf.length > PRICE_BUFFER_SIZE) sbuf.shift();
    }
  }

  getSnapshot(sym: Symbol): BrtiSnapshot | null {
    const buf = this.snapshots.get(sym);
    return buf && buf.length > 0 ? buf[buf.length - 1]! : null;
  }

  // Annualised σ from 1-second log returns.
  //   σ_annual = sd(r_1s) * sqrt(seconds_per_year)
  // Crypto trades 24/7 so the annualisation constant is 31_536_000.
  getSigmaAnnual(sym: Symbol): number | null {
    const buf = this.logReturns.get(sym);
    if (!buf || buf.length < 60) return null; // require ≥60s of samples
    const n = buf.length;
    const mean = buf.reduce((s, x) => s + x, 0) / n;
    const variance = buf.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(variance) * Math.sqrt(31_536_000);
  }

  // Top-of-book OFI across constituent venues.
  // Returns top1_imbalance averaged across active venues; top5_imbalance
  // requires level2 depth (Phase 2 — returns 0 for now).
  getOfi(sym: Symbol): OfiFeatures | null {
    const now = Date.now();
    let imbSum = 0;
    let count = 0;
    for (const a of this.adapters) {
      const t = this.ticks.get(`${a.venue}:${sym}`);
      if (!t) continue;
      if (now - t.ts_ms > TICK_STALE_MS) continue;
      const tot = t.bid_size + t.ask_size;
      if (tot <= 0) continue;
      imbSum += (t.bid_size - t.ask_size) / tot;
      count += 1;
    }
    if (count === 0) return null;
    return {
      symbol: sym,
      ts_ms: now,
      top1_imbalance: imbSum / count,
      top5_imbalance: 0, // TODO Phase 2
      aggressor_flow_1s: 0, // TODO Phase 2
      trade_count_1s: 0, // TODO Phase 2
    };
  }
}
