import { ClobClient, Side as SdkSide } from "@polymarket/clob-client-v2";
import { defaultEndpoints } from "../config";
import type { SdkSigner } from "../auth/createApiCreds";
import type { TradingSession } from "../auth/types";
import type { OrderIntent } from "./buildOrder";

export type SignedOrder = Awaited<ReturnType<ClobClient["createOrder"]>>;

export interface BuildClientOptions {
  session: TradingSession;
  signer: SdkSigner;
  host?: string;
}

export function buildAuthenticatedClient(opts: BuildClientOptions): ClobClient {
  const host = opts.host ?? defaultEndpoints.clob;
  return new ClobClient({
    host,
    chain: opts.session.chainId as 137 | 80002,
    signer: opts.signer,
    creds: opts.session.creds,
    signatureType: opts.session.signatureType,
    funderAddress: opts.session.funderAddress,
  });
}

export async function signOrderForSubmission(
  client: ClobClient,
  intent: OrderIntent,
): Promise<SignedOrder> {
  const side = intent.side === "BUY" ? SdkSide.BUY : SdkSide.SELL;
  return client.createOrder({
    tokenID: intent.tokenId,
    price: intent.price,
    size: intent.size,
    side,
  });
}
