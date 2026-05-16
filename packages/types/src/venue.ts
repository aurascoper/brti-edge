// Venue-neutral adapter interface for prediction-market execution.
//
// All venues normalize to this surface so the worker, panel, and strategy
// layers can treat Kalshi, (research-only) Polymarket, and any future venue
// uniformly. The interface is intentionally narrow — only the operations
// we actually need for dust trading.
//
// IMPORTANT: this interface is async-first. Every method returns a Promise
// because every venue goes over the network. Don't add synchronous accessors.

export type VenueId = "kalshi" | "polymarket" | "hyperliquid";

// Binary-market side: which leg of the contract (yes or no).
// Distinct from OrderAction (buy/sell) — you can buy YES, sell NO, etc.
export type BinarySide = "yes" | "no";
export type OrderAction = "buy" | "sell";
export type OrderKind = "limit" | "market"; // distinct from the Polymarket-CLOB OrderType ("GTC"|"FOK"|"FAK")
export type TimeInForce = "gtc" | "ioc" | "fok"; // GoodTilCancel / ImmediateOrCancel / FillOrKill

export interface VenueStatus {
  venue: VenueId;
  exchange_active: boolean;
  trading_active: boolean;
}

export interface VenueBalance {
  venue: VenueId;
  cash_usd: number; // available to open new positions, in USD
  portfolio_value_usd: number; // MTM of open positions
  raw: unknown; // venue-specific payload preserved for diagnostics
}

export interface VenueMarketSummary {
  venue: VenueId;
  ticker: string; // venue-native ticker (Kalshi: KXBTC15M-...; Polymarket: condition_id; etc.)
  title: string;
  // Binary / digital fields. Other contract shapes (multi-outcome, scalar)
  // come later via a separate adapter; for Phase 2 the strategy is binary-only.
  strike?: number | null; // floor_strike for "above" markets, cap_strike for "below"
  strike_type?: "above" | "below" | "between" | null;
  underlying?: string | null; // e.g., "BTC-USD"
  open_time?: string | null; // ISO 8601
  close_time: string; // ISO 8601
  status: "open" | "closed" | "settled" | "unknown";
  // Aggregate metrics; often null when venue doesn't expose them in list endpoints.
  volume?: number | null;
  liquidity?: number | null;
  open_interest?: number | null;
  raw: unknown;
}

export interface VenueOrderbookLevel {
  price: number; // YES probability in [0, 1]
  size: number; // contracts
}

export interface VenueOrderbook {
  venue: VenueId;
  ticker: string;
  // Bids descending (top-of-book at index 0).
  yes_bids: VenueOrderbookLevel[];
  no_bids: VenueOrderbookLevel[];
  // Top-of-book — null when the corresponding side has no resting bids.
  best_yes_bid: number | null;
  best_no_bid: number | null;
  // Derived via no-arbitrage from the OTHER side's bid; null when that side is empty.
  best_yes_ask: number | null;
  best_no_ask: number | null;
  mid_yes: number | null;
  spread: number | null; // best_yes_ask - best_yes_bid (== best_no_ask - best_no_bid)
  fetched_at: number; // unix ms
  raw: unknown;
}

export interface VenuePosition {
  venue: VenueId;
  ticker: string;
  side: BinarySide | null; // YES if positive, NO if implicit-negative — venue-dependent
  contracts: number; // signed; positive = long YES, negative = long NO (interpretation per venue)
  market_exposure_usd: number;
  realized_pnl_usd: number;
  fees_paid_usd: number;
  raw: unknown;
}

export interface VenueOrder {
  venue: VenueId;
  order_id: string;
  ticker: string;
  side: BinarySide;
  action: OrderAction;
  type: OrderKind;
  status: "resting" | "filled" | "canceled" | "rejected" | "pending" | "expired" | "unknown";
  price: number | null; // YES-price for either side
  remaining: number | null;
  filled: number | null;
  client_order_id?: string | null;
  created_ts: number; // unix s or ms — normalized to ms
  raw: unknown;
}

export interface VenueFill {
  venue: VenueId;
  fill_id: string;
  order_id: string;
  ticker: string;
  side: BinarySide;
  action: OrderAction;
  count: number;
  yes_price: number;
  no_price: number;
  is_taker: boolean;
  fees_usd: number;
  created_ts: number; // ms
  raw: unknown;
}

export interface SubmitOrderInput {
  ticker: string;
  side: BinarySide;
  action: OrderAction;
  type: OrderKind;
  count: number; // number of contracts
  price?: number | null; // YES-price; required for limit, omitted for market
  time_in_force?: TimeInForce;
  client_order_id?: string;
}

export interface SubmitOrderResult {
  success: boolean;
  order_id: string | null;
  status: VenueOrder["status"];
  error_code?: string | null;
  error_message?: string | null;
  raw: unknown;
}

export interface CancelOrderResult {
  success: boolean;
  order_id: string;
  status: VenueOrder["status"];
  error_code?: string | null;
  error_message?: string | null;
  raw: unknown;
}

export interface ListMarketsParams {
  status?: "open" | "closed" | "settled";
  series?: string; // venue-specific series filter (Kalshi: series_ticker; Polymarket: tag)
  limit?: number;
  cursor?: string;
}

export interface ListOrdersParams {
  ticker?: string;
  status?: VenueOrder["status"];
  limit?: number;
  cursor?: string;
}

export interface ListFillsParams {
  ticker?: string;
  limit?: number;
  cursor?: string;
}

export interface VenueAdapter {
  readonly venue: VenueId;
  getStatus(): Promise<VenueStatus>;
  getBalance(): Promise<VenueBalance>;
  listMarkets(params?: ListMarketsParams): Promise<VenueMarketSummary[]>;
  getMarket(ticker: string): Promise<VenueMarketSummary | null>;
  getOrderbook(ticker: string): Promise<VenueOrderbook>;
  listPositions(): Promise<VenuePosition[]>;
  listOrders(params?: ListOrdersParams): Promise<VenueOrder[]>;
  listFills(params?: ListFillsParams): Promise<VenueFill[]>;
  // submit/cancel are the only write-side methods. Adapters may throw
  // a "NotImplemented" error in research-only mode (e.g., PolymarketAdapter).
  submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult>;
  cancelOrder(orderId: string): Promise<CancelOrderResult>;
}

export class VenueNotImplementedError extends Error {
  constructor(public readonly venue: VenueId, public readonly method: string) {
    super(`${venue} adapter does not implement ${method} (research-only mode)`);
    this.name = "VenueNotImplementedError";
  }
}
