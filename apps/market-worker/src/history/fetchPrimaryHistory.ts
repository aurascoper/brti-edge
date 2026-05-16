import { fetchPriceHistory, type HistoryInterval } from "@polyterminal/polymarket-client";
import type { TimePoint } from "@polyterminal/types";

export async function fetchPrimaryHistoryPoints(
  yesTokenId: string,
  interval: HistoryInterval = "1h",
  fidelity = 60,
): Promise<TimePoint[]> {
  const raw = await fetchPriceHistory(yesTokenId, { interval, fidelity });
  return raw.map((r) => ({ ts: r.t * 1_000, value: r.p }));
}
