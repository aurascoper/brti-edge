import { ClobClient } from "@polymarket/clob-client-v2";

// Cancel endpoints return { canceled: string[], not_canceled: { [orderId]: reason } }.
// Normalized here in the same success/errorMsg/raw style as SubmitResult.
export interface CancelResult {
  success: boolean;
  canceled: string[];
  notCanceled: Record<string, string>;
  errorMsg: string | null;
  raw: unknown;
}

function normalizeCancelResponse(res: unknown): CancelResult {
  const r = (res ?? {}) as Record<string, unknown>;
  const canceled = Array.isArray(r.canceled) ? (r.canceled as string[]) : [];
  const notCanceled =
    r.not_canceled && typeof r.not_canceled === "object" && !Array.isArray(r.not_canceled)
      ? (r.not_canceled as Record<string, string>)
      : {};
  // The SDK's errorHandling() never throws here and surfaces failures as
  // { error, status } where error may be a string, a JSON object body, or an
  // Error instance — any truthy error (or an HTTP error status) is a failure,
  // not just string-typed errors.
  const status = typeof r.status === "number" ? r.status : null;
  const failed =
    Boolean(r.error) || typeof r.errorMsg === "string" || (status !== null && status >= 400);
  let errorMsg: string | null = null;
  if (failed) {
    if (typeof r.error === "string") errorMsg = r.error;
    else if (typeof r.errorMsg === "string") errorMsg = r.errorMsg;
    else if (r.error instanceof Error) errorMsg = r.error.message;
    else if (r.error !== undefined && r.error !== null) errorMsg = JSON.stringify(r.error);
    else errorMsg = `HTTP ${status}`;
  }
  const success = !failed && Object.keys(notCanceled).length === 0;
  return { success, canceled, notCanceled, errorMsg, raw: res };
}

export async function cancelOrder(client: ClobClient, orderId: string): Promise<CancelResult> {
  const res = (await client.cancelOrder({ orderID: orderId })) as unknown;
  const out = normalizeCancelResponse(res);
  // Single-order cancel: don't report success unless the venue explicitly
  // lists this order as canceled — an empty/ambiguous body must not read as
  // "canceled" while the order is still live on the book.
  if (out.success && !out.canceled.includes(orderId)) {
    return {
      ...out,
      success: false,
      errorMsg: out.errorMsg ?? `cancel response does not list ${orderId} as canceled`,
    };
  }
  return out;
}

export async function cancelOrders(client: ClobClient, orderIds: string[]): Promise<CancelResult> {
  const res = (await client.cancelOrders(orderIds)) as unknown;
  return normalizeCancelResponse(res);
}

export async function cancelAllOrders(client: ClobClient): Promise<CancelResult> {
  const res = (await client.cancelAll()) as unknown;
  return normalizeCancelResponse(res);
}
