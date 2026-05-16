"use client";

import { useCallback, useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { polygon } from "wagmi/chains";
import {
  buildAuthenticatedClient,
  buildOrderIntent,
  signOrderForSubmission,
  submitSignedOrder,
  type SubmitResult,
  type TradingSession,
} from "@polyterminal/polymarket-client";
import { postDustSubmitted, type DustCandidate } from "../lib/fetcher";

export type DustSubmitState =
  | { status: "idle" }
  | { status: "resolving" }
  | { status: "signing" }
  | { status: "submitting" }
  | { status: "success"; candidateId: string; result: SubmitResult }
  | { status: "rejected"; candidateId: string; error: string };

export interface DustSubmitInputs {
  candidate: DustCandidate;
  tokenId: string;
  session: TradingSession;
}

export function useDustSubmit(): {
  state: DustSubmitState;
  submit: (input: DustSubmitInputs) => Promise<SubmitResult | null>;
  reset: () => void;
} {
  const config = useConfig();
  const [state, setState] = useState<DustSubmitState>({ status: "idle" });

  const submit = useCallback(
    async ({ candidate, tokenId, session }: DustSubmitInputs): Promise<SubmitResult | null> => {
      try {
        setState({ status: "resolving" });
        const signer = await getWalletClient(config, { chainId: polygon.id });
        if (!signer) {
          setState({ status: "rejected", candidateId: candidate.id, error: "wallet client unavailable" });
          return null;
        }
        const intent = buildOrderIntent({
          tokenId,
          side: "BUY",
          price: candidate.price,
          size: candidate.size,
          orderType: "FAK",
          outcome: candidate.side,
        });
        setState({ status: "signing" });
        const client = buildAuthenticatedClient({ session, signer });
        const signed = await signOrderForSubmission(client, intent);
        setState({ status: "submitting" });
        const result = await submitSignedOrder(client, signed, intent.orderType);
        console.log("[dust-submit] postOrder result:", result);
        if (result.success) {
          await postDustSubmitted(candidate.id, result.orderId);
          setState({ status: "success", candidateId: candidate.id, result });
        } else {
          const errorParts = [
            result.errorMsg,
            result.status ? `status=${result.status}` : null,
            result.raw ? `raw=${JSON.stringify(result.raw).slice(0, 200)}` : null,
          ].filter(Boolean);
          const error = errorParts.length > 0 ? errorParts.join(" · ") : "submission failed (no detail)";
          setState({ status: "rejected", candidateId: candidate.id, error });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "rejected", candidateId: candidate.id, error: message });
        return null;
      }
    },
    [config],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, submit, reset };
}
