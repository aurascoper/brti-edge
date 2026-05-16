export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingSession {
  address: string;
  funderAddress: string;
  signatureType: number;
  creds: ApiCreds;
  chainId: number;
  derivedAt: number;
}

export type SessionState =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "ready"; session: TradingSession }
  | { status: "error"; error: string };

export const SIGNATURE_TYPE_EOA = 0;
export const SIGNATURE_TYPE_POLY_PROXY = 1;
export const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2;
export const SIGNATURE_TYPE_POLY_1271 = 3;
