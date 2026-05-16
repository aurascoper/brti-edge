export type ApprovalStatus = "ready" | "blocked" | "approval-required" | "unknown";

export type Side = "BUY" | "SELL";

export interface ApprovalInputs {
  side: Side;
  isConnected: boolean;
  onPolygon: boolean;
  cost: number | null;
  collateralBalance: number | null;
  collateralAllowance: number | null;
  tokenSymbol?: string;
}

export interface ApprovalDetails {
  walletConnected: boolean;
  onPolygon: boolean;
  balanceOk: boolean | null;
  allowanceOk: boolean | null;
  ctfApprovalNeeded: boolean | null;
}

export interface ApprovalState {
  status: ApprovalStatus;
  blockingReasons: string[];
  approvalReasons: string[];
  details: ApprovalDetails;
}

export function computeApprovalState(input: ApprovalInputs): ApprovalState {
  const {
    side,
    isConnected,
    onPolygon,
    cost,
    collateralBalance,
    collateralAllowance,
    tokenSymbol = "USDC.e",
  } = input;

  const blockingReasons: string[] = [];
  const approvalReasons: string[] = [];

  if (!isConnected) blockingReasons.push("wallet not connected");
  if (isConnected && !onPolygon) blockingReasons.push("wrong network — switch to Polygon");

  let balanceOk: boolean | null = null;
  let allowanceOk: boolean | null = null;
  let ctfApprovalNeeded: boolean | null = null;

  if (side === "BUY") {
    if (cost === null) {
      balanceOk = null;
      allowanceOk = null;
    } else {
      balanceOk = collateralBalance !== null ? collateralBalance >= cost : null;
      allowanceOk = collateralAllowance !== null ? collateralAllowance >= cost : null;
      if (balanceOk === false) {
        blockingReasons.push(`insufficient ${tokenSymbol} (need ${cost.toFixed(2)})`);
      }
      if (balanceOk !== false && allowanceOk === false) {
        approvalReasons.push(`${tokenSymbol} allowance to exchange required`);
      }
    }
  } else {
    ctfApprovalNeeded = true;
    approvalReasons.push("CTF outcome token approval may be required");
  }

  let status: ApprovalStatus;
  if (blockingReasons.length > 0) {
    status = "blocked";
  } else if (approvalReasons.length > 0 && side === "BUY") {
    status = "approval-required";
  } else if (side === "BUY" && balanceOk === null) {
    status = "unknown";
  } else if (side === "SELL") {
    status = "approval-required";
  } else {
    status = "ready";
  }

  return {
    status,
    blockingReasons,
    approvalReasons,
    details: {
      walletConnected: isConnected,
      onPolygon,
      balanceOk,
      allowanceOk,
      ctfApprovalNeeded,
    },
  };
}
