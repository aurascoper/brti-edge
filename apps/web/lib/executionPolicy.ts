import type { MarketSnapshot } from "@polyterminal/types";
import type { OrderIntent } from "@polyterminal/polymarket-client";
import type { ApprovalState } from "./approvalState";

export interface PolicyLimits {
  maxBookAgeSec: number;
  maxSlippagePct: number;
  maxNotionalUsd: number;
  maxSizeShares: number;
  minPrice: number;
  maxPrice: number;
  minSize: number;
  allowedOrderTypes: ReadonlyArray<"GTC" | "FAK">;
}

export const DEFAULT_LIMITS: PolicyLimits = {
  maxBookAgeSec: 60,
  maxSlippagePct: 0.05,
  maxNotionalUsd: 100,
  maxSizeShares: 10_000,
  minPrice: 0.01,
  maxPrice: 0.99,
  minSize: 1,
  allowedOrderTypes: ["GTC", "FAK"],
};

export interface PolicyResult {
  ok: boolean;
  violations: string[];
}

export interface PolicyInputs {
  intent: OrderIntent | null;
  primary: MarketSnapshot | null;
  refPrice: number | null;
  slippage: number | null;
  approvals: ApprovalState;
  limits?: Partial<PolicyLimits>;
}

export function evaluatePolicy(input: PolicyInputs): PolicyResult {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const violations: string[] = [];

  if (!input.intent) {
    violations.push("no order intent");
    return { ok: false, violations };
  }
  if (!input.primary) {
    violations.push("no market snapshot");
    return { ok: false, violations };
  }

  const i = input.intent;

  if (!i.tokenId) violations.push("no token id");
  if (!Number.isFinite(i.price) || i.price < limits.minPrice || i.price > limits.maxPrice) {
    violations.push(`price out of [${limits.minPrice}, ${limits.maxPrice}]`);
  }
  if (!Number.isFinite(i.size) || i.size < limits.minSize) {
    violations.push(`size < ${limits.minSize}`);
  }
  if (i.size > limits.maxSizeShares) {
    violations.push(`size > ${limits.maxSizeShares} (cap)`);
  }
  const notional = i.price * i.size;
  if (notional > limits.maxNotionalUsd) {
    violations.push(`notional $${notional.toFixed(2)} > $${limits.maxNotionalUsd} cap`);
  }
  if (!limits.allowedOrderTypes.includes(i.orderType)) {
    violations.push(`order type ${i.orderType} not allowed`);
  }

  const bookAge = input.primary.bookAgeSec;
  if (bookAge !== null && bookAge > limits.maxBookAgeSec) {
    violations.push(`stale book (${bookAge.toFixed(0)}s > ${limits.maxBookAgeSec}s)`);
  }

  if (input.refPrice !== null && input.slippage !== null && input.refPrice > 0) {
    const pct = input.slippage / input.refPrice;
    if (pct > limits.maxSlippagePct) {
      violations.push(`slippage ${(pct * 100).toFixed(2)}% > ${limits.maxSlippagePct * 100}% cap`);
    }
  }

  if (input.approvals.status === "blocked") {
    for (const r of input.approvals.blockingReasons) violations.push(r);
  }

  return { ok: violations.length === 0, violations };
}
