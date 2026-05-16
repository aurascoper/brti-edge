import type { Decision, DecisionInput, Strategy } from "./types";

const DEV_THRESHOLD = 0.05;
const SANE_YES_MIN = 0.15;
const SANE_YES_MAX = 0.85;
const DEFAULT_SIZE = 2;

export const meanReversion: Strategy = {
  name: "meanReversion",
  decide(input: DecisionInput): Decision {
    if (input.midYes === null) {
      return { side: "SKIP", size: 0, price: null, reason: "no_mid" };
    }
    if (input.midYes < SANE_YES_MIN || input.midYes > SANE_YES_MAX) {
      return {
        side: "SKIP",
        size: 0,
        price: null,
        reason: `yes=${input.midYes.toFixed(3)}_outside_sane_band`,
      };
    }
    const dev = input.midYes - 0.5;
    if (Math.abs(dev) < DEV_THRESHOLD) {
      return {
        side: "SKIP",
        size: 0,
        price: null,
        reason: `dev=${dev.toFixed(3)}_inside_band`,
      };
    }
    // Fade the extreme within sane band: if YES > 0.55, buy NO; if < 0.45, buy YES.
    const side: "YES" | "NO" = dev < 0 ? "YES" : "NO";
    const price =
      side === "YES"
        ? input.bestAskYes
        : input.bestBidYes !== null
          ? 1 - input.bestBidYes
          : null;
    return {
      side,
      size: DEFAULT_SIZE,
      price,
      reason: `dev=${dev.toFixed(3)}`,
    };
  },
};
