import type {
  BinarySide,
  CancelOrderResult,
  ListFillsParams,
  ListMarketsParams,
  ListOrdersParams,
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
import { KalshiClient } from "./client";
import { CRYPTO_15M_SERIES, isExecutionAllowed } from "./series";
import type {
  KalshiFill,
  KalshiMarket,
  KalshiOrder,
  KalshiOrderbook,
  KalshiPosition,
} from "./types";

const VENUE_ID: VenueId = "kalshi";

export interface KalshiAdapterOptions {
  client?: KalshiClient;
  // Phase 2 starts with allowOrders=false (read-only). Flip to true only after
  // the read path is proven end-to-end AND the dust executor is wired with
  // its hard caps (max notional / max trades / daily loss limit / manual confirm).
  allowOrders?: boolean;
}

export class KalshiAdapter implements VenueAdapter {
  readonly venue: VenueId = VENUE_ID;
  private readonly client: KalshiClient;
  private readonly allowOrders: boolean;

  constructor(opts: KalshiAdapterOptions = {}) {
    this.client = opts.client ?? new KalshiClient();
    this.allowOrders = opts.allowOrders ?? false;
  }

  async getStatus(): Promise<VenueStatus> {
    const s = await this.client.exchangeStatus();
    return { venue: VENUE_ID, exchange_active: s.exchange_active, trading_active: s.trading_active };
  }

  async getBalance(): Promise<VenueBalance> {
    const b = await this.client.getBalance();
    const cash_usd = b.balance / 100; // Kalshi returns integer cents
    const portfolio_value_usd = b.portfolio_value / 100;
    return { venue: VENUE_ID, cash_usd, portfolio_value_usd, raw: b };
  }

  async listMarkets(params: ListMarketsParams = {}): Promise<VenueMarketSummary[]> {
    const r = await this.client.listMarkets(compactParams({
      status: params.status,
      series_ticker: params.series,
      limit: params.limit,
      cursor: params.cursor,
    }));
    return r.markets.map(mapMarket);
  }

  async getMarket(ticker: string): Promise<VenueMarketSummary | null> {
    try {
      const r = await this.client.getMarket(ticker);
      return mapMarket(r.market);
    } catch {
      return null;
    }
  }

  async getOrderbook(ticker: string): Promise<VenueOrderbook> {
    const ob = await this.client.getOrderbook(ticker);
    return mapOrderbook(ob);
  }

  // Scan all configured 15-minute crypto series in parallel.
  // Returns the union of currently-open markets across all 9 series. Use this
  // for the worker's scan loop; execution is still gated per-series via the
  // executionAllowed flag in series.ts.
  async listAllCrypto15mOpen(perSeriesLimit = 5): Promise<VenueMarketSummary[]> {
    const results = await Promise.all(
      CRYPTO_15M_SERIES.map(async (s) => {
        try {
          const r = await this.client.listMarkets({
            status: "open",
            series_ticker: s.series,
            limit: perSeriesLimit,
          });
          return r.markets.map(mapMarket);
        } catch {
          return [] as VenueMarketSummary[];
        }
      }),
    );
    return results.flat();
  }

  async listPositions(): Promise<VenuePosition[]> {
    const r = await this.client.listPositions({ limit: 100 });
    return r.market_positions.map(mapPosition);
  }

  async listOrders(params: ListOrdersParams = {}): Promise<VenueOrder[]> {
    const r = await this.client.listOrders(compactParams({
      ticker: params.ticker,
      status: params.status,
      limit: params.limit,
      cursor: params.cursor,
    }));
    return r.orders.map(mapOrder);
  }

  async listFills(params: ListFillsParams = {}): Promise<VenueFill[]> {
    const r = await this.client.listFills(compactParams({
      ticker: params.ticker,
      limit: params.limit,
      cursor: params.cursor,
    }));
    return r.fills.map(mapFill);
  }

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    if (!this.allowOrders) {
      throw new VenueNotImplementedError(VENUE_ID, "submitOrder (allowOrders=false)");
    }
    if (!isExecutionAllowed(input.ticker)) {
      throw new VenueNotImplementedError(
        VENUE_ID,
        `submitOrder blocked: series for ${input.ticker} has executionAllowed=false`,
      );
    }
    if (input.type !== "limit") {
      // Phase 2.3b: limit-only by spec. Market orders deferred.
      throw new VenueNotImplementedError(
        VENUE_ID,
        `submitOrder only supports type="limit" (got "${input.type}")`,
      );
    }
    if (input.action !== "buy") {
      // Phase 2.3b: buy-only on first dust. Sells (closing positions) come later.
      throw new VenueNotImplementedError(
        VENUE_ID,
        `submitOrder only supports action="buy" (got "${input.action}")`,
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

    // Kalshi prices are integer cents (1-99). Round the venue-neutral
    // [0,1] price into cents; reject if it falls outside the legal band.
    const cents = Math.round(input.price * 100);
    if (cents < 1 || cents > 99) {
      return {
        success: false,
        order_id: null,
        status: "rejected",
        error_code: "client_error",
        error_message: `price ${input.price} → ${cents}¢ outside legal [1, 99]`,
        raw: null,
      };
    }

    const req: {
      ticker: string;
      client_order_id: string;
      side: "yes" | "no";
      action: "buy";
      type: "limit";
      count: number;
      yes_price?: number;
      no_price?: number;
    } = {
      ticker: input.ticker,
      client_order_id: input.client_order_id ?? `polyt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      side: input.side,
      action: "buy",
      type: "limit",
      count: input.count,
    };
    if (input.side === "yes") req.yes_price = cents;
    else req.no_price = cents;

    try {
      const res = await this.client.createOrder(req);
      const o = res.order;
      if (!o) {
        return {
          success: false,
          order_id: null,
          status: "rejected",
          error_message: "Kalshi response missing 'order' field",
          raw: res,
        };
      }
      return {
        success: true,
        order_id: o.order_id,
        status: normalizeOrderStatus(o.status),
        raw: res,
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
    try {
      const res = await this.client.cancelOrderById(orderId);
      return { success: true, order_id: orderId, status: "canceled", raw: res };
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

// Helper: strip undefined fields so exactOptionalPropertyTypes accepts the call.
function compactParams<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ---------------- mappers (Kalshi-native → venue-neutral) ----------------

function mapMarket(m: KalshiMarket): VenueMarketSummary {
  // Strike-type normalization. Kalshi uses "greater_or_equal" / "less_or_equal" / "between";
  // we collapse to "above" / "below" / "between" / null.
  let strike_type: VenueMarketSummary["strike_type"] = null;
  if (m.strike_type === "greater_or_equal") strike_type = "above";
  else if (m.strike_type === "less_or_equal") strike_type = "below";
  else if (m.strike_type === "between") strike_type = "between";
  // For "above" markets, the strike is floor_strike; for "below", cap_strike.
  let strike: number | null = null;
  if (strike_type === "above") strike = m.floor_strike ?? null;
  else if (strike_type === "below") strike = m.cap_strike ?? null;
  return {
    venue: VENUE_ID,
    ticker: m.ticker,
    title: m.title,
    strike,
    strike_type,
    // Prefer series_ticker; fall back to extracting from market ticker prefix.
    underlying: inferUnderlying(m.series_ticker ?? m.ticker.split("-")[0]),
    open_time: m.open_time ?? null,
    close_time: m.close_time,
    status: normalizeMarketStatus(m.status),
    volume: m.volume ?? null,
    liquidity: m.liquidity ?? null,
    open_interest: m.open_interest ?? null,
    raw: m,
  };
}

function normalizeMarketStatus(s: KalshiMarket["status"]): VenueMarketSummary["status"] {
  // Kalshi sometimes returns "active" for tradeable; map to "open".
  if (s === "active") return "open";
  if (s === "open" || s === "closed" || s === "settled") return s;
  return "unknown";
}

function inferUnderlying(series?: string): string | null {
  if (!series) return null;
  // Series tickers follow KX<TICKER><SUFFIX>: KXBTC15M → BTC, KXETHD → ETH, etc.
  const m = series.match(/^KX([A-Z]+)/);
  if (!m) return null;
  const token = m[1]!.replace(/(?:15M|M|D|MAX|MIN|Y|MON|W|Q|E|ATH)$/, "");
  if (!token) return null;
  return `${token}-USD`;
}

function mapOrderbook(ob: KalshiOrderbook): VenueOrderbook {
  return {
    venue: VENUE_ID,
    ticker: ob.ticker,
    yes_bids: ob.yes_bids,
    no_bids: ob.no_bids,
    best_yes_bid: ob.best_yes_bid,
    best_no_bid: ob.best_no_bid,
    best_yes_ask: ob.best_yes_ask,
    best_no_ask: ob.best_no_ask,
    mid_yes: ob.mid_yes,
    spread: ob.spread,
    fetched_at: ob.fetched_at,
    raw: ob,
  };
}

function mapPosition(p: KalshiPosition): VenuePosition {
  // Kalshi convention: `position` is signed; positive = long YES, negative = long NO.
  // For UI display we surface the side; for size we keep |contracts|.
  const side: BinarySide | null = p.position > 0 ? "yes" : p.position < 0 ? "no" : null;
  return {
    venue: VENUE_ID,
    ticker: p.ticker,
    side,
    contracts: p.position,
    market_exposure_usd: p.market_exposure / 100,
    realized_pnl_usd: p.realized_pnl / 100,
    fees_paid_usd: p.fees_paid / 100,
    raw: p,
  };
}

function normalizeOrderStatus(s: string | undefined): VenueOrder["status"] {
  if (!s) return "unknown";
  if (s === "executed") return "filled";
  if (s === "resting" || s === "canceled" || s === "pending") return s;
  // Kalshi sometimes returns mixed casings or new statuses; default safely.
  const list: VenueOrder["status"][] = ["resting", "filled", "canceled", "rejected", "pending", "expired"];
  return list.includes(s as VenueOrder["status"]) ? (s as VenueOrder["status"]) : "unknown";
}

function mapOrder(o: KalshiOrder): VenueOrder {
  const ticker = o.ticker ?? o.market_ticker ?? "";
  const side = (o.side ?? o.outcome_side ?? "yes") as "yes" | "no";
  const yesPrice = o.yes_price_dollars !== undefined ? Number(o.yes_price_dollars) : null;
  const noPrice = o.no_price_dollars !== undefined ? Number(o.no_price_dollars) : null;
  const remaining = o.remaining_count_fp !== undefined ? Number(o.remaining_count_fp) : null;
  const filled = o.fill_count_fp !== undefined ? Number(o.fill_count_fp) : null;
  const created_ts = o.created_time ? Date.parse(o.created_time) : 0;
  return {
    venue: VENUE_ID,
    order_id: o.order_id,
    ticker,
    side,
    action: o.action,
    type: o.type ?? "limit",
    status: o.status === "executed" ? "filled" : (o.status as VenueOrder["status"]),
    price: side === "yes" ? yesPrice : noPrice,
    remaining,
    filled,
    client_order_id: o.client_order_id ?? null,
    created_ts,
    raw: o,
  };
}

function mapFill(f: KalshiFill): VenueFill {
  // Kalshi uses string fields for fractional precision (count_fp, *_dollars).
  // Parse them to numbers. Also tolerate alternative field names that appear
  // on different endpoint versions (fill_id vs trade_id, market_ticker vs ticker,
  // outcome_side vs side, ts vs created_time).
  const fillId = f.trade_id ?? f.fill_id ?? "";
  const ticker = f.ticker ?? f.market_ticker ?? "";
  const side = (f.side ?? f.outcome_side ?? "yes") as "yes" | "no";
  const count = Number(f.count_fp);
  const yes_price = Number(f.yes_price_dollars);
  const no_price = Number(f.no_price_dollars);
  const fees_usd = f.fee_cost !== undefined ? Number(f.fee_cost) : 0;
  const created_ts =
    f.ts !== undefined ? f.ts * 1000 : Date.parse(f.created_time ?? "");
  return {
    venue: VENUE_ID,
    fill_id: fillId,
    order_id: f.order_id,
    ticker,
    side,
    action: f.action,
    count,
    yes_price,
    no_price,
    is_taker: f.is_taker,
    fees_usd,
    created_ts,
    raw: f,
  };
}
