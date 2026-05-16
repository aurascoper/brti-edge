import type { Decision, DecisionInput, Strategy } from "./types";

const DEFAULT_SIZE = 2;

export const naiveYes: Strategy = {
  name: "naiveYes",
  decide(input: DecisionInput): Decision {
    if (input.bestAskYes === null) {
      return { side: "SKIP", size: 0, price: null, reason: "no_ask" };
    }
    return {
      side: "YES",
      size: DEFAULT_SIZE,
      price: input.bestAskYes,
      reason: "always",
    };
  },
};
