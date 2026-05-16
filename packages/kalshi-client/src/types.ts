// Kalshi API response types.
// Surfaces only the fields we use; raw responses always available via .raw.

export interface KalshiBalance {
  balance: number; // cents, integer
  balance_breakdown: Array<{
    balance: string; // dollar string with 4 decimals, e.g. "57.6700"
    exchange_index: number;
  }>;
  portfolio_value: number; // cents
  updated_ts: number; // unix seconds
}

export interface KalshiMarket {
  ticker: string;
  series_ticker?: string;
  event_ticker?: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string; // e.g. "Target Price: $81,383.72"
  status: "open" | "closed" | "settled" | "initialized" | "active";
  open_time?: string;
  close_time: string;
  // Strike fields — present for digital/threshold markets like KXBTC15M.
  // For "greater_or_equal" type, YES resolves if observed >= floor_strike at close.
  floor_strike?: number;
  cap_strike?: number;
  strike_type?: "greater_or_equal" | "less_or_equal" | "between" | "structured";
  // Summary fields — often null on Kalshi list endpoints; always derive
  // top-of-book from the orderbook endpoint instead.
  yes_bid?: number | null;
  yes_ask?: number | null;
  no_bid?: number | null;
  no_ask?: number | null;
  last_price?: number | null;
  volume?: number | null;
  volume_24h?: number | null;
  liquidity?: number | null;
  open_interest?: number | null;
  result?: string;
}

export interface KalshiOrderbookLevel {
  // Kalshi orderbook is BIDS ONLY in dollars (4-decimal strings).
  // Source array is sorted ASCENDING by price.
  price: number;
  size: number;
}

// Normalized orderbook with top-of-book derived correctly.
//
// Kalshi-specific interpretation rules (verified empirically 2026-05-14):
//   - orderbook_fp.{yes,no}_dollars are BIDS ONLY, ascending by price
//   - best bid on a side = MAX price in that side's array (last entry)
//   - no explicit asks published; derive via no-arbitrage identity:
//       best_yes_ask = 1 - best_no_bid
//       best_no_ask  = 1 - best_yes_bid
//   - mid_yes = (best_yes_bid + best_yes_ask) / 2
//   - spread = best_yes_ask - best_yes_bid  (equivalently for no)
//
// `yes_bids` and `no_bids` are exposed DESCENDING (top-of-book first)
// after normalization for downstream convenience.
export interface KalshiOrderbook {
  ticker: string;
  yes_bids: KalshiOrderbookLevel[]; // descending price (top-of-book first)
  no_bids: KalshiOrderbookLevel[]; // descending price
  best_yes_bid: number | null;
  best_no_bid: number | null;
  best_yes_ask: number | null; // derived: 1 - best_no_bid
  best_no_ask: number | null; // derived: 1 - best_yes_bid
  mid_yes: number | null;
  spread: number | null;
  fetched_at: number; // unix ms client-side
}

export interface KalshiPosition {
  ticker: string;
  position: number; // signed contract count
  market_exposure: number; // cents
  realized_pnl: number; // cents
  fees_paid: number; // cents
  resting_orders_count: number;
  last_updated_ts: number;
}

// Kalshi /portfolio/orders response shape (verified empirically 2026-05-15).
// Prices are dollar strings ("0.2700"); counts are integer strings ("3.00").
// We parse them in mapOrder.
export interface KalshiOrder {
  order_id: string;
  ticker?: string;
  market_ticker?: string;
  side: "yes" | "no";
  outcome_side?: "yes" | "no";
  action: "buy" | "sell";
  type?: "market" | "limit";
  status: "resting" | "canceled" | "executed" | "pending" | string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  remaining_count_fp?: string;
  fill_count_fp?: string;
  initial_count_fp?: string;
  client_order_id?: string;
  created_time?: string; // ISO 8601
  expiration_time?: string | null;
}

// Kalshi /portfolio/fills response shape (verified empirically 2026-05-15).
// String fields are used for fractional precision; we parse them in mapFill.
// Note: both `trade_id` and `fill_id` are returned with the same value; both
// `ticker` and `market_ticker` are returned. We accept either to be robust.
export interface KalshiFill {
  trade_id: string;
  fill_id?: string;
  order_id: string;
  ticker: string;
  market_ticker?: string;
  side: "yes" | "no";
  outcome_side?: "yes" | "no";
  action: "buy" | "sell";
  count_fp: string; // e.g. "1.00"
  yes_price_dollars: string; // e.g. "0.7300"
  no_price_dollars: string; // e.g. "0.2700"
  fee_cost?: string; // dollars, may be "0.000000"
  is_taker: boolean;
  created_time: string; // ISO 8601
  ts?: number; // unix seconds, sometimes provided alongside created_time
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

export interface KalshiPositionsResponse {
  market_positions: KalshiPosition[];
  event_positions: unknown[];
  cursor: string;
}

export interface KalshiOrdersResponse {
  orders: KalshiOrder[];
  cursor: string;
}

export interface KalshiFillsResponse {
  fills: KalshiFill[];
  cursor: string;
}

// Kalshi POST /portfolio/orders request body.
// Prices are integer CENTS (1-99). Sub-cent prices shown in the orderbook
// are not orderable; round to nearest cent before submitting.
export interface KalshiCreateOrderRequest {
  ticker: string;
  client_order_id: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  count: number;
  yes_price?: number; // integer cents, required when side="yes" AND type="limit"
  no_price?: number; // integer cents, required when side="no" AND type="limit"
  // For type="market" buys, Kalshi uses buy_max_cost (cents) instead of price.
  buy_max_cost?: number;
  // 0 = good-till-cancel; future unix-seconds = good-till-date. Omit for default GTC.
  expiration_ts?: number;
  // Optional post-only / IOC flags surface in v2 as fields below; not all are
  // available on every venue tier. Keep optional; verify per-key entitlements.
  post_only?: boolean;
}

export interface KalshiCreateOrderResponse {
  order?: {
    order_id: string;
    user_id: string;
    ticker: string;
    side: "yes" | "no";
    action: "buy" | "sell";
    type: "limit" | "market";
    status: "resting" | "canceled" | "executed" | "pending" | string;
    yes_price?: number;
    no_price?: number;
    initial_count?: number;
    remaining_count?: number;
    client_order_id?: string;
    created_time?: string;
    expiration_time?: string | null;
  };
  // On error Kalshi returns { error: { code, message, ... } } with non-2xx.
}

export interface KalshiOrderbookRawResponse {
  orderbook?: {
    yes?: Array<[string, string]>;
    no?: Array<[string, string]>;
  };
  orderbook_fp?: {
    yes_dollars?: Array<[string, string]>;
    no_dollars?: Array<[string, string]>;
  };
}
