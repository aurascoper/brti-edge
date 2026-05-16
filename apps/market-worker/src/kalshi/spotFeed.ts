// Lightweight underlying-spot poller + realized vol estimator.
//
// For Phase 2.2a (BTC-only execution), this polls BTCUSDT via Binance REST every
// ~3 seconds and maintains a rolling tape for realized-vol estimation. Plenty
// for the 15m strike-distance model — we don't need WS-tier latency for dry-run.
//
// When ETH/SOL/etc. get unlocked (Phase 2.3+), instantiate one SpotFeed per
// symbol. The same class works unchanged for any Binance USDT-quoted ticker.

// Binance global (api.binance.com) is geo-blocked for US users (HTTP 451).
// Binance.US exposes a compatible REST API at api.binance.us with the same
// ticker symbols (BTCUSDT, ETHUSDT, etc.) and response shape. Override via
// SPOT_FEED_REST env if needed (e.g., switch to coinbase, cryptocompare).
const BINANCE_REST = process.env.SPOT_FEED_REST ?? "https://api.binance.us";

export interface SpotTick {
  ts: number; // unix ms
  price: number;
}

export class SpotFeed {
  private readonly symbol: string;
  private readonly tape: SpotTick[] = [];
  private readonly capacity: number;
  private latest: number | null = null;
  private latestAt = 0;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(symbol: string, opts: { capacity?: number } = {}) {
    this.symbol = symbol;
    // Capacity = ~30 min of 3-sec ticks = 600 points; plenty for σ over 5-15 min windows
    this.capacity = opts.capacity ?? 600;
  }

  async start(intervalMs = 3_000): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.pollOnce();
    this.intervalId = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getSpot(): number | null {
    return this.latest;
  }

  // Annualized realized volatility from log-returns of the tape.
  // Uses simple sample stdev × √(periods_per_year).
  getSigmaAnnual(): number | null {
    if (this.tape.length < 10) return null;
    const logRets: number[] = [];
    for (let i = 1; i < this.tape.length; i++) {
      const prev = this.tape[i - 1]!.price;
      const cur = this.tape[i]!.price;
      if (prev > 0 && cur > 0) logRets.push(Math.log(cur / prev));
    }
    if (logRets.length < 5) return null;
    const mean = logRets.reduce((a, b) => a + b, 0) / logRets.length;
    const variance =
      logRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (logRets.length - 1);
    const stdevPerStep = Math.sqrt(variance);
    // Annualize from per-step (assume ~3 sec/step average; if interval varies the
    // ratio of dt to year still calibrates).
    const meanDtMs =
      (this.tape[this.tape.length - 1]!.ts - this.tape[0]!.ts) / (this.tape.length - 1);
    const stepsPerYear = (365 * 24 * 3600 * 1000) / meanDtMs;
    return stdevPerStep * Math.sqrt(stepsPerYear);
  }

  getTapeAgeSec(): number | null {
    if (this.latestAt === 0) return null;
    return (Date.now() - this.latestAt) / 1000;
  }

  private async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${BINANCE_REST}/api/v3/ticker/price?symbol=${this.symbol}`);
      if (!res.ok) return;
      const body = (await res.json()) as { price: string };
      const px = Number(body.price);
      if (!Number.isFinite(px) || px <= 0) return;
      const now = Date.now();
      this.latest = px;
      this.latestAt = now;
      this.tape.push({ ts: now, price: px });
      while (this.tape.length > this.capacity) this.tape.shift();
    } catch {
      // network blip — keep last good value
    }
  }
}
