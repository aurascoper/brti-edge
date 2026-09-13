/** Isolated cellular demo adapter. The legacy maker adapter is not imported.
 * Wire reference (checked 2026-09-13):
 * https://docs.kalshi.com/api-reference/orders/create-order-v2
 * All prices are YES-book dollar strings; all arithmetic below is fixed-point.
 */
import { signRequest, pathForSigning, type KalshiCredentials } from "./auth.js";

export type Outcome = "YES" | "NO";
export type Action = "buy" | "sell";
export interface Intent {
  ticker: string; clientOrderId: string; outcome: Outcome; action: Action;
  priceDollars: string; quantity: string; subaccount: number; exchangeIndex?: 0 | 2;
}
export interface V2Order {
  ticker: string; client_order_id: string; side: "bid" | "ask";
  price: string; count: string; time_in_force: "immediate_or_cancel";
  post_only: false; reduce_only: boolean; cancel_order_on_pause: true;
  self_trade_prevention_type: "taker_at_cross"; subaccount: number; exchange_index: 0 | 2;
}

function fail(reason: string): never { throw new Error(reason); }

export function fixedPrice(value: string): bigint {
  if (typeof value !== "string" || !/^0\.\d{1,4}$/.test(value)) fail("invalid_fixed_price");
  const units = BigInt(value.slice(2).padEnd(4, "0"));
  if (units <= 0n || units >= 10000n) fail("invalid_binary_price");
  return units;
}
function dollars(units: bigint): string { return `0.${units.toString().padStart(4, "0")}`; }

export function translate(intent: Intent): V2Order {
  if (!intent.ticker.startsWith("KXBTC15M-") || !intent.clientOrderId) fail("unsupported_order_identity");
  if (!["YES", "NO"].includes(intent.outcome) || !["buy", "sell"].includes(intent.action)) fail("unknown_side_or_action");
  if (!/^\d+(?:\.0{1,2})?$/.test(intent.quantity) || BigInt(intent.quantity.split(".")[0]!) <= 0n) fail("whole_contracts_only");
  if (!Number.isSafeInteger(intent.subaccount) || intent.subaccount < 0) fail("invalid_subaccount");
  const exchange = intent.exchangeIndex === undefined ? 0 : intent.exchangeIndex;
  if (exchange !== 0 && exchange !== 2) fail("unsupported_exchange_index");
  const units = fixedPrice(intent.priceDollars);
  const yesPrice = intent.outcome === "YES" ? units : 10000n - units;
  const bid = (intent.outcome === "YES") === (intent.action === "buy");
  return { ticker: intent.ticker, client_order_id: intent.clientOrderId,
    side: bid ? "bid" : "ask", price: dollars(yesPrice), count: `${BigInt(intent.quantity.split(".")[0]!)}.00`,
    time_in_force: "immediate_or_cancel", post_only: false, reduce_only: intent.action === "sell",
    cancel_order_on_pause: true, self_trade_prevention_type: "taker_at_cross", subaccount: intent.subaccount, exchange_index: exchange };
}

/** Validate the deliberately narrower cellular schema before any network call. */
export function validateV2(raw: unknown): asserts raw is V2Order {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_v2_shape");
  const r = raw as Record<string, unknown>;
  const keys = ["ticker", "client_order_id", "side", "price", "count", "time_in_force", "post_only", "reduce_only", "cancel_order_on_pause", "self_trade_prevention_type", "subaccount", "exchange_index"].sort();
  if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(keys)) fail("legacy_or_unknown_v2_field");
  if (typeof r.ticker !== "string" || !r.ticker.startsWith("KXBTC15M-") || typeof r.client_order_id !== "string" || !r.client_order_id) fail("invalid_order_identity");
  if (!["bid", "ask"].includes(String(r.side)) || typeof r.price !== "string") fail("invalid_v2_side");
  fixedPrice(r.price);
  if (typeof r.count !== "string" || !/^[1-9]\d*\.00$/.test(r.count)) fail("invalid_v2_count");
  if (r.time_in_force !== "immediate_or_cancel" || r.post_only !== false || r.cancel_order_on_pause !== true || r.self_trade_prevention_type !== "taker_at_cross") fail("taker_policy_required");
  if (typeof r.reduce_only !== "boolean" || !Number.isSafeInteger(r.subaccount) || Number(r.subaccount) < 0) fail("invalid_v2_options");
  if (r.exchange_index !== 0 && r.exchange_index !== 2) fail("unsupported_exchange_index");
}

export function checkEnvironment(env: NodeJS.ProcessEnv, mode: "PAPER" | "DEMO"): void {
  if (env.CELLULAR_PROCESS_ROLE !== "executor") fail("adapter_requires_executor_role");
  // Legacy unscoped keys have unknown provenance: also refuse them.
  if (Object.entries(env).some(([key, value]) => value && (key.startsWith("KALSHI_PROD_") || key === "KALSHI_API_KEY_ID" || key === "KALSHI_PRIVATE_KEY_PATH"))) fail("production_or_unscoped_credentials_present");
  if (mode === "PAPER" && Object.entries(env).some(([key, value]) => value && key.startsWith("KALSHI_DEMO_"))) fail("paper_credentials_present");
}

export function requireManualCount(seriesUntested: boolean, firstN: number): void {
  if (!Number.isSafeInteger(firstN) || firstN < 0 || (seriesUntested && firstN === 0)) fail("manual_confirmation_required");
}

export function activeDemoSeries(series: unknown, markets: unknown, nowMs: number): boolean {
  const s = series as { ticker?: string; frequency?: string } | null;
  if (s?.ticker !== "KXBTC15M" || s.frequency !== "fifteen_min" || !Array.isArray(markets)) return false;
  return markets.some((m: Record<string, unknown>) => typeof m.ticker === "string" && m.ticker.startsWith("KXBTC15M-") &&
    ["open", "active"].includes(String(m.status)) && typeof m.open_time === "string" && typeof m.close_time === "string" &&
    Date.parse(m.open_time) <= nowMs && nowMs < Date.parse(m.close_time));
}

export async function collectPages<T>(read: (cursor: string) => Promise<unknown>, field: string, identity: (row: T) => string): Promise<T[]> {
  const rows: T[] = [], cursors = new Set<string>(), identities = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 1000; page++) {
    const response = await read(cursor) as Record<string, unknown>;
    if (!response || !Array.isArray(response[field]) || typeof response.cursor !== "string") fail("incomplete_page");
    for (const row of response[field] as T[]) {
      const id = identity(row);
      if (!id || identities.has(id)) fail("duplicate_or_missing_page_identity");
      identities.add(id); rows.push(row);
    }
    cursor = response.cursor as string;
    if (!cursor) return rows;
    if (cursors.has(cursor)) fail("pagination_cycle");
    cursors.add(cursor);
  }
  return fail("pagination_limit");
}

/** DEMO only. A timeout is propagated as ambiguous; there is no retry loop. */
export class CellularDemoAdapter {
  readonly baseUrl = "https://external-api.demo.kalshi.co/trade-api/v2";
  constructor(private readonly credentials: KalshiCredentials, private readonly transport: typeof fetch = fetch,
              env: NodeJS.ProcessEnv = process.env) { checkEnvironment(env, "DEMO"); }

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, expectedStatus?: number, submitBeforeMs?: number): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) fail("invalid_relative_path");
    const headers = signRequest(this.credentials, method, pathForSigning("/trade-api/v2", path));
    if (submitBeforeMs !== undefined && (!Number.isFinite(submitBeforeMs) || Date.now() >= submitBeforeMs)) fail("demo_submission_deadline_elapsed");
    const response = await this.transport(this.baseUrl + path, { method, headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) fail(`demo_http_${response.status}`);
    return response.json();
  }

  async submit(order: V2Order, submitBeforeMs?: number): Promise<unknown> {
    validateV2(order);
    return this.request("POST", "/portfolio/events/orders", order, 201, submitBeforeMs);
  }
}
