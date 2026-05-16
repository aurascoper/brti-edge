"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  clearFunder,
  isHexAddress,
  loadFunder,
  saveFunder,
  SIGNATURE_TYPE_BY_MODEL,
  type TraderModel,
} from "../lib/traderModel";

export interface FunderState {
  eoa: string | null;
  funderAddress: `0x${string}` | null;
  model: TraderModel;
  signatureType: number;
  setFunder: (address: string, model: TraderModel) => boolean;
  reset: () => void;
}

export function useFunder(): FunderState {
  const { address } = useAccount();
  const [funderAddress, setFunderAddress] = useState<`0x${string}` | null>(null);
  const [model, setModel] = useState<TraderModel>("EOA");

  useEffect(() => {
    const eoa = address?.toLowerCase() ?? null;
    if (!eoa) {
      setFunderAddress(null);
      setModel("EOA");
      return;
    }
    const rec = loadFunder(eoa);
    if (rec && isHexAddress(rec.address)) {
      setFunderAddress(rec.address as `0x${string}`);
      setModel(rec.model);
    } else {
      setFunderAddress((address ?? null) as `0x${string}` | null);
      setModel("EOA");
    }
  }, [address]);

  const setFunder = useCallback(
    (addr: string, m: TraderModel): boolean => {
      if (!address) return false;
      const trimmed = addr.trim();
      if (!isHexAddress(trimmed)) return false;
      saveFunder(address, { address: trimmed, model: m });
      setFunderAddress(trimmed as `0x${string}`);
      setModel(m);
      return true;
    },
    [address],
  );

  const reset = useCallback(() => {
    if (!address) return;
    clearFunder(address);
    setFunderAddress(address as `0x${string}`);
    setModel("EOA");
  }, [address]);

  return {
    eoa: address?.toLowerCase() ?? null,
    funderAddress,
    model,
    signatureType: SIGNATURE_TYPE_BY_MODEL[model],
    setFunder,
    reset,
  };
}
