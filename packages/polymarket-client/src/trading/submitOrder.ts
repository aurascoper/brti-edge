import { ClobClient, OrderType as SdkOrderType } from "@polymarket/clob-client-v2";
import type { SignedOrder } from "./signOrder";
import type { SupportedOrderType } from "./buildOrder";

export interface SubmitResult {
  success: boolean;
  orderId: string | null;
  errorMsg: string | null;
  status: string | null;
  takingAmount: string | null;
  makingAmount: string | null;
  transactionsHashes: string[];
  raw: unknown;
}

export async function submitSignedOrder(
  client: ClobClient,
  signed: SignedOrder,
  orderType: SupportedOrderType,
): Promise<SubmitResult> {
  const sdkType = orderType === "FAK" ? SdkOrderType.FAK : SdkOrderType.GTC;
  const res = (await client.postOrder(signed, sdkType)) as Record<string, unknown>;
  return {
    success: Boolean(res.success),
    orderId: typeof res.orderID === "string" ? res.orderID : null,
    errorMsg: typeof res.errorMsg === "string" ? res.errorMsg : null,
    status: typeof res.status === "string" ? res.status : null,
    takingAmount: typeof res.takingAmount === "string" ? res.takingAmount : null,
    makingAmount: typeof res.makingAmount === "string" ? res.makingAmount : null,
    transactionsHashes: Array.isArray(res.transactionsHashes)
      ? (res.transactionsHashes as string[])
      : [],
    raw: res,
  };
}
