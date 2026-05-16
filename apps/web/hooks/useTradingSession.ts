"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConfig } from "wagmi";
import { getWalletClient, switchChain } from "wagmi/actions";
import { polygon } from "wagmi/chains";
import {
  clearSession as clearStored,
  deriveTradingSession,
  loadSession,
  saveSession,
  type SessionState,
  type TradingSession,
} from "@polyterminal/polymarket-client";

export interface UseTradingSessionOptions {
  funderAddress: `0x${string}` | null;
  signatureType: number;
}

function sessionKey(eoa: string, funder: string | null, sigType: number): string {
  return `${eoa.toLowerCase()}:${funder ?? ""}:${sigType}`;
}

export function useTradingSession(opts: UseTradingSessionOptions): {
  state: SessionState;
  ensureSession: () => Promise<TradingSession | null>;
  clear: () => void;
} {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const config = useConfig();
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = address
      ? sessionKey(address, opts.funderAddress, opts.signatureType)
      : null;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    if (!key) {
      setState({ status: "idle" });
      return;
    }
    const cached = loadSession(key);
    if (cached) setState({ status: "ready", session: cached });
    else setState({ status: "idle" });
  }, [address, opts.funderAddress, opts.signatureType]);

  useEffect(() => {
    if (!isConnected) {
      clearStored();
      setState({ status: "idle" });
    }
  }, [isConnected]);

  const ensureSession = useCallback(async (): Promise<TradingSession | null> => {
    if (state.status === "preparing") return null;
    if (state.status === "ready") return state.session;
    if (!isConnected || !address) {
      setState({ status: "error", error: "wallet not connected" });
      return null;
    }
    setState({ status: "preparing" });
    try {
      if (chainId !== polygon.id) {
        try {
          await switchChain(config, { chainId: polygon.id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ status: "error", error: `chain switch needed: ${message}` });
          return null;
        }
      }
      const signer = await getWalletClient(config, { chainId: polygon.id });
      if (!signer) {
        setState({ status: "error", error: "wallet client unavailable (try disconnect + reconnect)" });
        return null;
      }
      const session = await deriveTradingSession({
        signer,
        chainId: polygon.id,
        ...(opts.funderAddress ? { funderAddress: opts.funderAddress } : {}),
        signatureType: opts.signatureType,
      });
      const key = sessionKey(address, opts.funderAddress, opts.signatureType);
      saveSession({ ...session, address: key });
      setState({ status: "ready", session });
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", error: message });
      return null;
    }
  }, [address, chainId, config, isConnected, opts.funderAddress, opts.signatureType, state]);

  const clear = useCallback(() => {
    if (address) {
      const key = sessionKey(address, opts.funderAddress, opts.signatureType);
      clearStored(key);
    }
    setState({ status: "idle" });
  }, [address, opts.funderAddress, opts.signatureType]);

  return { state, ensureSession, clear };
}
