import type { Decision, DecisionInput, Strategy } from "./types";

const MIN_TAPE_POINTS = 5;
const LOOKBACK_MS = 30_000;
const LOGRET_THRESHOLD = 0.0003;
const DEFAULT_SIZE = 2;

export const momentum: Strategy = {
  name: "momentum",
  decide(input: DecisionInput): Decision {
    if (input.btcTape.length < MIN_TAPE_POINTS) {
      return { side: "SKIP", size: 0, price: null, reason: "tape<min" };
    }
    const cutoff = input.nowMs - LOOKBACK_MS;
    const window = input.btcTape.filter((p) => p.ts >= cutoff);
    if (window.length < MIN_TAPE_POINTS) {
      return { side: "SKIP", size: 0, price: null, reason: "window<min" };
    }
    const first = window[0]!.price;
    const last = window[window.length - 1]!.price;
    if (first <= 0 || last <= 0) {
      return { side: "SKIP", size: 0, price: null, reason: "non-positive_price" };
    }
    const logret = Math.log(last / first);
    if (Math.abs(logret) < LOGRET_THRESHOLD) {
      return {
        side: "SKIP",
        size: 0,
        price: null,
        reason: `logret=${logret.toFixed(5)}_inside_band`,
      };
    }
    const side: "YES" | "NO" = logret > 0 ? "YES" : "NO";
    const price = priceForSide(side, input.bestBidYes, input.bestAskYes);
    return {
      side,
      size: DEFAULT_SIZE,
      price,
      reason: `logret=${logret.toFixed(5)}_n=${window.length}`,
    };
  },
};

function priceForSide(
  side: "YES" | "NO",
  bidYes: number | null,
  askYes: number | null,
): number | null {
  if (side === "YES") return askYes;
  if (bidYes === null) return null;
  return 1 - bidYes;
}
