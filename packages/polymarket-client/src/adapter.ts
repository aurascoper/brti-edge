import type {
  BinarySide,
  CancelOrderResult,
  ListFillsParams,
  ListMarketsParams,
  ListOrdersParams,
  OrderBook,
  SubmitOrderInput,
  SubmitOrderResult,
  VenueAdapter,
  VenueBalance,
  VenueFill,
  VenueId,
  VenueMarketSummary,
  VenueOrder,
  VenueOrderbook,
  VenuePosition,
  VenueStatus,
} from "@polyterminal/types";
import { VenueNotImplementedError } from "@polyterminal/types";
import { ClobClient } from "@polymarket/clob-client-v2";
import { defaultEndpoints } from "./config";
import type { GammaEventMarket } from "./gamma/fetchEvents";
import { fetchMarkets, type FetchMarketsParams } from "./gamma/fetchMarkets";
import { fetchBook } from "./clob/fetchBook";
import { fetchPositions, type DataApiPosition } from "./data/fetchPositions";
import { fetchTrades, type DataApiTrade, type FetchTradesParams } from "./data/fetchTrades";
import { fetchPortfolioValue } from "./data/fetchValue";
import { fetchOpenOrders, type NormalizedOpenOrder } from "./trading/openOrders";
import { cancelOrder as cancelClobOrder } from "./trading/cancelOrder";
import { buildOrderIntent, type SupportedOrderType } from "./trading/buildOrder";
import { buildAuthenticatedClient, signOrderForSubmission } from "./trading/signOrder";
import { submitSignedOrder } from "./trading/submitOrder";
import type { SdkSigner } from "./auth/createApiCreds";
import type { TradingSession } from "./auth/types";

const VENUE_ID: VenueId = "polymarket";

export interface PolymarketAdapterOptions {
  // Phase 1 starts with allowOrders=false (read-only). Flip to true only after
  // the read path is proven end-to-end AND the canary is wired with its hard
  // caps (max notional / max trades / daily loss limit / manual confirm).
  allowOrders?: boolean;
  // Required for listOrders/submitOrder/cancelOrder (L2-authenticated paths).
  session?: TradingSession;
  signer?: SdkSigner;
  // Address used for data-api reads (balance/positions/fills) when no session
  // is present; defaults to session.funderAddress.
  userAddress?: string;
  endpoints?: typeof defaultEndpoints;
}

export class PolymarketAdapter implements VenueAdapter {
  readonly venue: VenueId = VENUE_ID;
  private readonly allowOrders: boolean;
  private readonly session: TradingSession | undefined;
  private readonly signer: SdkSigner | undefined;
  private readonly userAddress: string | undefined;
  private readonly endpoints: typeof defaultEndpoints;
  private client: ClobClient | null = null;

  constructor(opts: PolymarketAdapterOptions = {}) {
    this.allowOrders = opts.allowOrders ?? false;
    this.session = opts.session;
    this.signer = opts.signer;
    this.userAddress = opts.userAddress;
    this.endpoints = opts.endpoints ?? defaultEndpoints;
  }

  private requireClient(method: string): ClobClient {
    if (!this.session || !this.signer) {
      throw new Error(`polymarket ${method} requires session+signer (see createHeadlessSession)`);
    }
    if (!this.client) {
      this.client = buildAuthenticatedClient({
        session: this.session,
        signer: this.signer,
        host: this.endpoints.clob,
      });
    }
    return this.client;
  }

  private requireUserAddress(method: string): string {
    const addr = this.userAddress ?? this.session?.funderAddress;
    if (!addr) throw new Error(`polymarket ${method} requires userAddress or session.funderAddress`);
    return addr;
  }

  async getStatus(): Promise<VenueStatus> {
    // Polymarket has no exchange-status endpoint; CLOB /time reachability
    // stands in for both flags.
    try {
      const res = await fetch(`${this.endpoints.clob}/time`);
      return { venue: VENUE_ID, exchange_active: res.ok, trading_active: res.ok };
    } catch {
      return { venue: VENUE_ID, exchange_active: false, trading_active: false };
    }
  }

  async getBalance(): Promise<VenueBalance> {
    const user = this.requireUserAddress("getBalance");
    const portfolio_value_usd = await fetchPortfolioValue(user, this.endpoints);
    // The data-api exposes no cash (USDC) balance; an on-chain wallet query is
    // out of scope for the research-only adapter, so cash_usd is reported as 0.
    return { venue: VENUE_ID, cash_usd: 0, portfolio_value_usd, raw: { user, portfolio_value_usd } };
  }

  async listMarkets(params: ListMarketsParams = {}): Promise<VenueMarketSummary[]> {
    const gammaParams: FetchMarketsParams = {};
    if (params.status === "open") {
      gammaParams.closed = false;
      gammaParams.active = true;
    } else if (params.status === "closed" || params.status === "settled") {
      gammaParams.closed = true;
    }
    if (params.limit !== undefined) gammaParams.limit = params.limit;
    // params.series / params.cursor have no gamma /markets equivalent — ignored.
    const rows = await fetchMarkets(gammaParams, this.endpoints);
    return rows.map(mapMarket);
  }

  async getMarket(ticker: string): Promise<VenueMarketSummary | null> {
    try {
      const rows = await fetchMarkets({ conditionIds: [ticker] }, this.endpoints);
      const m = rows[0];
      return m ? mapMarket(m) : null;
    } catch {
      return null;
    }
  }

  async getOrderbook(ticker: string): Promise<VenueOrderbook> {
    const rows = await fetchMarkets({ conditionIds: [ticker] }, this.endpoints);
    const m = rows[0];
    if (!m) throw new Error(`polymarket market not found: ${ticker}`);
    const yesToken = parseClobTokenIds(m)[0];
    if (!yesToken) throw new Error(`polymarket market ${ticker} has no clobTokenIds`);
    const book = await fetchBook(yesToken, this.endpoints);
    return mapOrderbook(ticker, book);
  }

  async listPositions(): Promise<VenuePosition[]> {
    const user = this.requireUserAddress("listPositions");
    const rows = await fetchPositions({ user, limit: 100 }, this.endpoints);
    return rows.map(mapPosition);
  }

  async listOrders(params: ListOrdersParams = {}): Promise<VenueOrder[]> {
    const client = this.requireClient("listOrders");
    const openParams: { market?: string } = {};
    if (params.ticker !== undefined) openParams.market = params.ticker;
    const rows = await fetchOpenOrders(client, openParams);
    const mapped = rows.map(mapOrder);
    return params.status !== undefined ? mapped.filter((o) => o.status === params.status) : mapped;
  }

  async listFills(params: ListFillsParams = {}): Promise<VenueFill[]> {
    const user = this.requireUserAddress("listFills");
    const q: FetchTradesParams = { user };
    if (params.limit !== undefined) q.limit = params.limit;
    if (params.ticker !== undefined) q.market = params.ticker;
    const rows = await fetchTrades(q, this.endpoints);
    return rows.map(mapFill);
  }

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    if (!this.allowOrders) {
      throw new VenueNotImplementedError(VENUE_ID, "submitOrder (allowOrders=false)");
    }
    if (input.type !== "limit") {
      // Phase 1: limit-only, mirroring the Kalshi adapter. Market orders deferred.
      throw new VenueNotImplementedError(
        VENUE_ID,
        `submitOrder only supports type="limit" (got "${input.type}")`,
      );
    }
    if (input.action !== "buy") {
      // Phase 1: buy-only on first canary. Sells (closing positions) come later.
      throw new VenueNotImplementedError(
        VENUE_ID,
        `submitOrder only supports action="buy" (got "${input.action}")`,
      );
    }
    if (input.time_in_force === "fok") {
      throw new VenueNotImplementedError(
        VENUE_ID,
        'submitOrder does not support time_in_force="fok" (GTC/FAK only)',
      );
    }
    if (input.price == null || !Number.isFinite(input.price)) {
      return {
        success: false,
        order_id: null,
        status: "rejected",
        error_code: "client_error",
        error_message: "limit order requires a price",
        raw: null,
      };
    }

    // Venue-neutral price is always the YES probability; a NO buy crosses the
    // NO token at 1 - price.
    const tokenPrice = input.side === "no" ? round4(1 - input.price) : round4(input.price);
    if (tokenPrice <= 0 || tokenPrice >= 1) {
      return {
        success: false,
        order_id: null,
        status: "rejected",
        error_code: "client_error",
        error_message: `price ${input.price} → token price ${tokenPrice} outside legal (0, 1)`,
        raw: null,
      };
    }

    const client = this.requireClient("submitOrder");
    try {
      const rows = await fetchMarkets({ conditionIds: [input.ticker] }, this.endpoints);
      const m = rows[0];
      if (!m) {
        return {
          success: false,
          order_id: null,
          status: "rejected",
          error_message: `polymarket market not found: ${input.ticker}`,
          raw: null,
        };
      }
      const tokens = parseClobTokenIds(m);
      const tokenId = input.side === "yes" ? tokens[0] : tokens[1];
      if (!tokenId) {
        return {
          success: false,
          order_id: null,
          status: "rejected",
          error_message: `polymarket market ${input.ticker} missing clobTokenIds for side "${input.side}"`,
          raw: m,
        };
      }
      const orderType: SupportedOrderType = input.time_in_force === "ioc" ? "FAK" : "GTC";
      const intent = buildOrderIntent({
        tokenId,
        side: "BUY",
        price: tokenPrice,
        size: input.count,
        orderType,
        outcome: input.side,
      });
      const signed = await signOrderForSubmission(client, intent);
      const res = await submitSignedOrder(client, signed, orderType);
      return {
        success: res.success,
        order_id: res.orderId,
        status: res.success ? normalizeSubmitStatus(res.status) : "rejected",
        error_message: res.errorMsg,
        raw: res.raw,
      };
    } catch (err) {
      return {
        success: false,
        order_id: null,
        status: "rejected",
        error_message: (err as Error).message,
        raw: err,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<CancelOrderResult> {
    if (!this.allowOrders) {
      throw new VenueNotImplementedError(VENUE_ID, "cancelOrder (allowOrders=false)");
    }
    const client = this.requireClient("cancelOrder");
    try {
      const res = await cancelClobOrder(client, orderId);
      if (res.success) {
        return { success: true, order_id: orderId, status: "canceled", raw: res.raw };
      }
      return {
        success: false,
        order_id: orderId,
        status: "rejected",
        error_message: res.errorMsg ?? res.notCanceled[orderId] ?? "cancel not confirmed",
        raw: res.raw,
      };
    } catch (err) {
      return {
        success: false,
        order_id: orderId,
        status: "rejected",
        error_message: (err as Error).message,
        raw: err,
      };
    }
  }
}

// ---------------- mappers (Polymarket-native → venue-neutral) ----------------

function round4(p: number): number {
  return Math.round(p * 10_000) / 10_000;
}

// gamma serializes clobTokenIds as a JSON string: '["<yesTokenId>","<noTokenId>"]'
function parseClobTokenIds(m: GammaEventMarket): string[] {
  try {
    const parsed = JSON.parse(m.clobTokenIds) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toNum(v: number | string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function binarySideFromOutcome(outcome: string, outcomeIndex: number): BinarySide {
  const o = outcome.toLowerCase();
  if (o === "yes" || o === "up") return "yes";
  if (o === "no" || o === "down") return "no";
  return outcomeIndex === 0 ? "yes" : "no";
}

function mapMarket(m: GammaEventMarket): VenueMarketSummary {
  return {
    venue: VENUE_ID,
    ticker: m.conditionId,
    title: m.question,
    strike: null, // gamma /markets exposes no strike metadata
    strike_type: null,
    underlying: null,
    open_time: null,
    close_time: m.endDate ?? "",
    status: m.closed ? "closed" : m.active ? "open" : "unknown",
    volume: toNum(m.volume24hr),
    liquidity: toNum(m.liquidity),
    open_interest: null,
    raw: m,
  };
}

function mapOrderbook(ticker: string, book: OrderBook): VenueOrderbook {
  // The CLOB book is quoted on the YES token; NO-side bids are YES asks
  // through the 1-p no-arbitrage identity (a resting YES ask at p fills a
  // NO buy at 1-p).
  const best_yes_bid = book.bids[0]?.price ?? null;
  const best_yes_ask = book.asks[0]?.price ?? null;
  const best_no_bid = best_yes_ask != null ? round4(1 - best_yes_ask) : null;
  const best_no_ask = best_yes_bid != null ? round4(1 - best_yes_bid) : null;
  return {
    venue: VENUE_ID,
    ticker,
    yes_bids: book.bids.map((l) => ({ price: l.price, size: l.size })),
    no_bids: book.asks.map((l) => ({ price: round4(1 - l.price), size: l.size })),
    best_yes_bid,
    best_no_bid,
    best_yes_ask,
    best_no_ask,
    mid_yes:
      best_yes_bid != null && best_yes_ask != null
        ? round4((best_yes_bid + best_yes_ask) / 2)
        : null,
    spread:
      best_yes_bid != null && best_yes_ask != null ? round4(best_yes_ask - best_yes_bid) : null,
    fetched_at: Number.isFinite(book.timestamp) ? book.timestamp : Date.now(),
    raw: book,
  };
}

function mapPosition(p: DataApiPosition): VenuePosition {
  // Data-api rows are per-token longs; venue convention is signed contracts
  // (positive = long YES, negative = long NO).
  const side = binarySideFromOutcome(p.outcome, p.outcomeIndex);
  return {
    venue: VENUE_ID,
    ticker: p.conditionId,
    side,
    contracts: side === "no" ? -p.size : p.size,
    market_exposure_usd: p.currentValue,
    realized_pnl_usd: p.realizedPnl,
    fees_paid_usd: 0, // data-api does not expose fees
    raw: p,
  };
}

function normalizeOpenOrderStatus(s: string): VenueOrder["status"] {
  const u = s.toUpperCase();
  if (u === "LIVE") return "resting";
  if (u === "MATCHED") return "filled";
  if (u === "CANCELED" || u === "CANCELLED") return "canceled";
  return "unknown";
}

function normalizeSubmitStatus(s: string | null): VenueOrder["status"] {
  if (s === "live") return "resting";
  if (s === "matched") return "filled";
  if (s === "delayed" || s === "unmatched") return "pending";
  return "unknown";
}

function mapOrder(o: NormalizedOpenOrder): VenueOrder {
  const side = binarySideFromOutcome(o.outcome, 0);
  return {
    venue: VENUE_ID,
    order_id: o.orderId,
    ticker: o.market,
    side,
    action: o.side === "SELL" ? "sell" : "buy",
    type: "limit", // CLOB resting orders are limit by construction
    status: normalizeOpenOrderStatus(o.status),
    // Venue convention: price is the YES-price for either side.
    price: side === "no" ? round4(1 - o.price) : o.price,
    remaining: o.remaining,
    filled: o.sizeMatched,
    client_order_id: null,
    created_ts: o.createdAt,
    raw: o.raw,
  };
}

function mapFill(t: DataApiTrade): VenueFill {
  const side = binarySideFromOutcome(t.outcome, t.outcomeIndex);
  const yes_price = side === "no" ? round4(1 - t.price) : t.price;
  return {
    venue: VENUE_ID,
    fill_id: `${t.transactionHash}-${t.asset}`, // data-api trades carry no fill id
    order_id: "", // not exposed by the data-api
    ticker: t.conditionId,
    side,
    action: t.side === "SELL" ? "sell" : "buy",
    count: t.size,
    yes_price,
    no_price: round4(1 - yes_price),
    is_taker: true, // data-api /trades returns taker-side rows by default
    fees_usd: 0, // not exposed
    created_ts: t.timestamp * 1000, // data-api timestamps are unix seconds
    raw: t,
  };
}
