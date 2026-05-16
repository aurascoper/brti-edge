"use client";

import { useCallback, useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { polygon } from "wagmi/chains";
import {
  buildAuthenticatedClient,
  signOrderForSubmission,
  submitSignedOrder,
  type OrderIntent,
  type SubmitResult,
  type TradingSession,
} from "@polyterminal/polymarket-client";

export type SubmitState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "submitting" }
  | { status: "success"; result: SubmitResult }
  | { status: "rejected"; error: string };

export interface UseOrderSubmit {
  state: SubmitState;
  submit: (intent: OrderIntent, session: TradingSession) => Promise<SubmitResult | null>;
  reset: () => void;
}

export function useOrderSubmit(): UseOrderSubmit {
  const config = useConfig();
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  const submit = useCallback(
    async (intent: OrderIntent, session: TradingSession): Promise<SubmitResult | null> => {
      try {
        const signer = await getWalletClient(config, { chainId: polygon.id });
        if (!signer) {
          setState({ status: "rejected", error: "wallet client unavailable" });
          return null;
        }
        setState({ status: "signing" });
        const client = buildAuthenticatedClient({ session, signer });
        const signed = await signOrderForSubmission(client, intent);
        setState({ status: "submitting" });
        const result = await submitSignedOrder(client, signed, intent.orderType);
        if (result.success) {
          setState({ status: "success", result });
        } else {
          setState({ status: "rejected", error: result.errorMsg ?? "submission failed" });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "rejected", error: message });
        return null;
      }
    },
    [config],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, submit, reset };
}
