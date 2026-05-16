// Synthetic-BRTI aggregator.
//
// Subscribes to constituent venue feeds, maintains per-venue rolling tick
// state, and emits a 1-second benchmark snapshot computed as a robust
// trimmed mean of constituent mid prices. σ is estimated from a separate
// 1-minute resampled log-return buffer (not from 1s returns — see comment
// on MINUTE_RETURN_BUFFER below). OFI features use the 1s tick state.
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

const TICK_STALE_MS = 5000;          // drop ticks older than this from snapshot
const SNAPSHOT_INTERVAL_MS = 1000;   // emit one snapshot per second
const SNAPSHOT_BUFFER_SIZE = 3600;   // 1 hour of 1s snapshots (audit + OFI)
// σ is estimated from log returns sampled at the 1-minute boundary, not at 1s.
// Trimmed-mean BRTI prices are smooth — the variance of 1s returns is dominated
// by price-quantization at the cent / sub-cent level rather than real motion,
// which deflates the 1s-based σ estimate well below realized vol. Sampling at
// 60-second wall-clock buckets lets per-bucket price drift accumulate enough
// signal to dominate quantization noise and brings σ back in line with what
// the single-venue 3s Binance SpotFeed reports.
const MINUTE_RETURN_BUFFER = 60;     // 1h rolling window of 1-min returns
const MIN_MINUTE_SAMPLES = 5;        // need ≥5 min of samples before σ is usable
const MINUTES_PER_YEAR = 525_600;    // 365 × 24 × 60, crypto trades 24/7

export class BrtiAggregator {
  private symbols: Symbol[];
  private adapters: VenueAdapter[];

  // latest tick per venue × symbol
  private ticks: Map<string, VenueTick> = new Map();
  // rolling 1s benchmark snapshots per symbol
  private snapshots: Map<Symbol, BrtiSnapshot[]> = new Map();
  // 1-minute resampled log returns used for σ estimation
  private minuteReturns: Map<Symbol, number[]> = new Map();
  private lastMinutePrice: Map<Symbol, number> = new Map();
  private lastMinuteBucket: Map<Symbol, number> = new Map();

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
      this.minuteReturns.set(s, []);
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

      // 1-minute resampling for σ. On each new wall-clock minute bucket,
      // compute log(price_now / price_at_previous_bucket) and append. Skip
      // the very first observation per symbol (no prior bucket to diff).
      const bucket = Math.floor(now / 60_000);
      const prevBucket = this.lastMinuteBucket.get(sym);
      if (prevBucket !== bucket) {
        const prevPrice = this.lastMinutePrice.get(sym);
        if (prevPrice !== undefined && prevPrice > 0 && price > 0) {
          const r = Math.log(price / prevPrice);
          const buf = this.minuteReturns.get(sym)!;
          buf.push(r);
          if (buf.length > MINUTE_RETURN_BUFFER) buf.shift();
        }
        this.lastMinutePrice.set(sym, price);
        this.lastMinuteBucket.set(sym, bucket);
      }

      const sbuf = this.snapshots.get(sym)!;
      sbuf.push(snap);
      if (sbuf.length > SNAPSHOT_BUFFER_SIZE) sbuf.shift();
    }
  }

  getSnapshot(sym: Symbol): BrtiSnapshot | null {
    const buf = this.snapshots.get(sym);
    return buf && buf.length > 0 ? buf[buf.length - 1]! : null;
  }

  // Annualised σ from 1-minute resampled log returns.
  //   σ_annual = sd(r_1m) * sqrt(minutes_per_year)
  // Need MIN_MINUTE_SAMPLES populated, which means ~MIN_MINUTE_SAMPLES wall
  // clock minutes of aggregator uptime after the first tick lands. Crypto
  // trades 24/7 so the annualisation constant is 525_600 = 365 × 24 × 60.
  getSigmaAnnual(sym: Symbol): number | null {
    const buf = this.minuteReturns.get(sym);
    if (!buf || buf.length < MIN_MINUTE_SAMPLES) return null;
    const n = buf.length;
    const mean = buf.reduce((s, x) => s + x, 0) / n;
    const variance = buf.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(variance) * Math.sqrt(MINUTES_PER_YEAR);
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
