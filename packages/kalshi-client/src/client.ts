import { loadCredentialsFromEnv, pathForSigning, signRequest, type KalshiCredentials } from "./auth";
import type {
  KalshiBalance,
  KalshiCreateOrderRequest,
  KalshiCreateOrderResponse,
  KalshiFillsResponse,
  KalshiMarket,
  KalshiMarketsResponse,
  KalshiOrderbook,
  KalshiOrderbookRawResponse,
  KalshiOrdersResponse,
  KalshiPosition,
  KalshiPositionsResponse,
} from "./types";

const DEFAULT_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PATH_PREFIX = "/trade-api/v2";

export interface KalshiClientOptions {
  baseUrl?: string;
  credentials?: KalshiCredentials;
}

export class KalshiClient {
  private readonly baseUrl: string;
  private readonly credentials: KalshiCredentials;

  constructor(opts: KalshiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.KALSHI_API_BASE ?? DEFAULT_BASE;
    this.credentials = opts.credentials ?? loadCredentialsFromEnv();
  }

  // ---------------- auth helpers ----------------

  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    relativePath: string,
    body?: unknown,
  ): Promise<T> {
    const baseHeaders = signRequest(
      this.credentials,
      method,
      pathForSigning(PATH_PREFIX, relativePath),
    );
    const headers: Record<string, string> = { ...baseHeaders };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(this.baseUrl + relativePath, init);
    if (!res.ok) {
      const text = await res.text();
      throw new KalshiApiError(res.status, text, method, relativePath);
    }
    return (await res.json()) as T;
  }

  private async publicRequest<T>(relativePath: string): Promise<T> {
    const res = await fetch(this.baseUrl + relativePath, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new KalshiApiError(res.status, text, "GET", relativePath);
    }
    return (await res.json()) as T;
  }

  // ---------------- public ----------------

  async exchangeStatus(): Promise<{ exchange_active: boolean; trading_active: boolean }> {
    return this.publicRequest("/exchange/status");
  }

  async listMarkets(params: {
    status?: "open" | "closed" | "settled";
    series_ticker?: string;
    event_ticker?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<KalshiMarketsResponse> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.series_ticker) q.set("series_ticker", params.series_ticker);
    if (params.event_ticker) q.set("event_ticker", params.event_ticker);
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return this.publicRequest(`/markets${qs ? `?${qs}` : ""}`);
  }

  async getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.publicRequest(`/markets/${encodeURIComponent(ticker)}`);
  }

  async getOrderbook(ticker: string): Promise<KalshiOrderbook> {
    const raw = await this.publicRequest<KalshiOrderbookRawResponse>(
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
    );
    return parseOrderbook(ticker, raw);
  }

  // ---------------- signed (read-only — Phase 1) ----------------

  async getBalance(): Promise<KalshiBalance> {
    return this.signedRequest("GET", "/portfolio/balance");
  }

  async listPositions(params: { limit?: number; cursor?: string } = {}): Promise<KalshiPositionsResponse> {
    const q = new URLSearchParams();
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return this.signedRequest("GET", `/portfolio/positions${qs ? `?${qs}` : ""}`);
  }

  async listOrders(params: { ticker?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<KalshiOrdersResponse> {
    const q = new URLSearchParams();
    if (params.ticker) q.set("ticker", params.ticker);
    if (params.status) q.set("status", params.status);
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return this.signedRequest("GET", `/portfolio/orders${qs ? `?${qs}` : ""}`);
  }

  async listFills(params: { ticker?: string; limit?: number; cursor?: string } = {}): Promise<KalshiFillsResponse> {
    const q = new URLSearchParams();
    if (params.ticker) q.set("ticker", params.ticker);
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return this.signedRequest("GET", `/portfolio/fills${qs ? `?${qs}` : ""}`);
  }

  // Convenience: open 15-minute BTC up/down markets (the strategy's target family).
  async listKxbtc15mOpen(limit = 10): Promise<KalshiMarket[]> {
    const r = await this.listMarkets({ status: "open", series_ticker: "KXBTC15M", limit });
    return r.markets;
  }

  // Convenience: nearest-closing KXBTC15M (the currently-live 15-min window).
  async getCurrentKxbtc15m(): Promise<KalshiMarket | null> {
    const m = await this.listKxbtc15mOpen(5);
    if (m.length === 0) return null;
    return [...m].sort((a, b) => a.close_time.localeCompare(b.close_time))[0]!;
  }

  // ---------------- write-side (signed) ----------------

  async createOrder(req: KalshiCreateOrderRequest): Promise<KalshiCreateOrderResponse> {
    return this.signedRequest<KalshiCreateOrderResponse>("POST", "/portfolio/orders", req);
  }

  async cancelOrderById(orderId: string): Promise<unknown> {
    return this.signedRequest("DELETE", `/portfolio/orders/${encodeURIComponent(orderId)}`);
  }
}

export class KalshiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`Kalshi ${status} ${method} ${path}: ${body.slice(0, 200)}`);
    this.name = "KalshiApiError";
  }
}

function parseOrderbook(ticker: string, raw: KalshiOrderbookRawResponse): KalshiOrderbook {
  // Source arrays are BIDS only, sorted ascending by price.
  // We flip to descending so top-of-book is at index 0 for downstream code.
  const yesAsc = raw.orderbook_fp?.yes_dollars ?? raw.orderbook?.yes ?? [];
  const noAsc = raw.orderbook_fp?.no_dollars ?? raw.orderbook?.no ?? [];
  const yes_bids = yesAsc
    .map(([p, s]) => ({ price: Number(p), size: Number(s) }))
    .reverse();
  const no_bids = noAsc.map(([p, s]) => ({ price: Number(p), size: Number(s) })).reverse();
  const best_yes_bid = yes_bids[0]?.price ?? null;
  const best_no_bid = no_bids[0]?.price ?? null;
  // No-arbitrage derived asks. Round to 4dp to match Kalshi tick precision.
  const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const best_yes_ask = best_no_bid !== null ? round4(1 - best_no_bid) : null;
  const best_no_ask = best_yes_bid !== null ? round4(1 - best_yes_bid) : null;
  const mid_yes =
    best_yes_bid !== null && best_yes_ask !== null
      ? round4((best_yes_bid + best_yes_ask) / 2)
      : null;
  const spread =
    best_yes_bid !== null && best_yes_ask !== null ? round4(best_yes_ask - best_yes_bid) : null;
  return {
    ticker,
    yes_bids,
    no_bids,
    best_yes_bid,
    best_no_bid,
    best_yes_ask,
    best_no_ask,
    mid_yes,
    spread,
    fetched_at: Date.now(),
  };
}
