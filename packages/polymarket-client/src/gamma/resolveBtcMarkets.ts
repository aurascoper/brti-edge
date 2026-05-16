import type { MarketDescriptor, OutcomeToken } from "@polyterminal/types";
import { fetchEvents, type GammaEvent, type GammaEventMarket } from "./fetchEvents";

const BTC_PATTERNS = [/\bbtc\b/i, /\bbitcoin\b/i];

function parseJsonList<T>(s: string | undefined): T[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function isBtc(text: string): boolean {
  return BTC_PATTERNS.some((p) => p.test(text));
}

export function gammaMarketToDescriptor(m: GammaEventMarket, tags: string[] = []): MarketDescriptor {
  const outcomes = parseJsonList<string>(m.outcomes);
  const prices = parseJsonList<string>(m.outcomePrices).map((p) => Number(p));
  const tokenIds = parseJsonList<string>(m.clobTokenIds);
  const tokens: OutcomeToken[] = outcomes.map((outcome, i) => ({
    tokenId: tokenIds[i] ?? "",
    outcome,
    price: prices[i] ?? Number.NaN,
  }));
  return {
    conditionId: m.conditionId,
    slug: m.slug,
    question: m.question,
    endDateIso: m.endDate ?? null,
    closed: !!m.closed,
    active: !!m.active,
    tokens,
    volume24h: num(m.volume24hr),
    liquidity: num(m.liquidity),
    tags,
  };
}

export interface SelectionThresholds {
  yesMin: number;
  yesMax: number;
  minVolume24h: number;
  minLiquidity: number;
  minSecondsToExpiry: number;
  maxSecondsToExpiry: number;
  watchlistSize: number;
  weightVolume: number;
  weightLiquidity: number;
  weightAtm: number;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const DEFAULT_THRESHOLDS: SelectionThresholds = {
  yesMin: envNum("POLYTERMINAL_YES_MIN", 0.10),
  yesMax: envNum("POLYTERMINAL_YES_MAX", 0.90),
  minVolume24h: envNum("POLYTERMINAL_MIN_VOL_24H", 0),
  minLiquidity: envNum("POLYTERMINAL_MIN_LIQUIDITY", 0),
  minSecondsToExpiry: envNum("POLYTERMINAL_MIN_SECS_TO_EXPIRY", 60),
  maxSecondsToExpiry: envNum("POLYTERMINAL_MAX_SECS_TO_EXPIRY", 1800),
  watchlistSize: envNum("POLYTERMINAL_WATCHLIST_SIZE", 8),
  weightVolume: envNum("POLYTERMINAL_WEIGHT_VOL", 0.45),
  weightLiquidity: envNum("POLYTERMINAL_WEIGHT_LIQ", 0.20),
  weightAtm: envNum("POLYTERMINAL_WEIGHT_ATM", 0.35),
};

export const INCUMBENT_GRACE_FACTOR = 0.8;

export interface RankedMarket {
  descriptor: MarketDescriptor;
  yesPrice: number;
  score: number;
  components: { atm: number; vol: number; liq: number };
}

export interface ResolveBtcMarketsResult {
  primary: MarketDescriptor | null;
  watchlist: MarketDescriptor[];
  graph: MarketDescriptor[];
  ranked: RankedMarket[];
}

export interface ResolveBtcMarketsOptions {
  limit?: number;
  thresholds?: Partial<SelectionThresholds>;
  now?: number;
  incumbentConditionId?: string | null;
}

function yesPriceOf(d: MarketDescriptor): number | null {
  const p = d.tokens[0]?.price;
  return p !== undefined && Number.isFinite(p) ? p : null;
}

function eligible(
  d: MarketDescriptor,
  t: SelectionThresholds,
  nowMs: number,
  isIncumbent = false,
): boolean {
  if (d.closed || !d.active) return false;
  if (!d.tokens[0]?.tokenId) return false;
  if (d.endDateIso) {
    const end = Date.parse(d.endDateIso);
    if (Number.isFinite(end)) {
      const secsToExpiry = (end - nowMs) / 1000;
      if (secsToExpiry < t.minSecondsToExpiry) return false;
      if (t.maxSecondsToExpiry > 0 && secsToExpiry > t.maxSecondsToExpiry) return false;
    }
  }
  const grace = isIncumbent ? INCUMBENT_GRACE_FACTOR : 1;
  const yes = yesPriceOf(d);
  if (yes === null) return false;
  const yesPad = isIncumbent ? 0.02 : 0;
  if (yes < t.yesMin - yesPad || yes > t.yesMax + yesPad) return false;
  const vol = d.volume24h ?? 0;
  if (vol < t.minVolume24h * grace) return false;
  const liq = d.liquidity ?? 0;
  if (liq < t.minLiquidity * grace) return false;
  return true;
}

export function scoreMarkets(
  descriptors: MarketDescriptor[],
  thresholds: SelectionThresholds = DEFAULT_THRESHOLDS,
  now = Date.now(),
  incumbentConditionId: string | null = null,
): RankedMarket[] {
  const eligibleSet = descriptors.filter((d) =>
    eligible(d, thresholds, now, d.conditionId === incumbentConditionId),
  );
  if (eligibleSet.length === 0) return [];

  const maxVol = Math.max(...eligibleSet.map((d) => d.volume24h ?? 0), 0);
  const maxLiq = Math.max(...eligibleSet.map((d) => d.liquidity ?? 0), 0);
  const logMaxVol = Math.log1p(maxVol);
  const logMaxLiq = Math.log1p(maxLiq);

  const ranked: RankedMarket[] = eligibleSet.map((d) => {
    const yes = yesPriceOf(d)!;
    const atm = Math.max(0, 1 - 2 * Math.abs(yes - 0.5));
    const vol = logMaxVol > 0 ? Math.log1p(d.volume24h ?? 0) / logMaxVol : 0;
    const liq = logMaxLiq > 0 ? Math.log1p(d.liquidity ?? 0) / logMaxLiq : 0;
    const score =
      thresholds.weightVolume * vol +
      thresholds.weightLiquidity * liq +
      thresholds.weightAtm * atm;
    return { descriptor: d, yesPrice: yes, score, components: { atm, vol, liq } };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export async function resolveBtcMarkets(
  opts: ResolveBtcMarketsOptions = {},
): Promise<ResolveBtcMarketsResult> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const now = opts.now ?? Date.now();

  const cryptoLimit = opts.limit ?? 80;
  // "up-or-down" needs higher limit because the API returns ~95 stale-but-active expired markets
  // before reaching current 5-min markets when sorted ascending by endDate.
  const upOrDownLimit = opts.limit ?? 250;
  // "crypto" tag → longer-term BTC markets (sorted desc for highest-vol first)
  // "up-or-down" tag → recurring short-duration markets (sorted asc to reach imminent markets)
  const eventBatches = await Promise.all([
    fetchEvents({
      active: true,
      closed: false,
      limit: cryptoLimit,
      tagSlug: "crypto",
      order: "volume24hr",
      ascending: false,
    }),
    fetchEvents({
      active: true,
      closed: false,
      limit: upOrDownLimit,
      tagSlug: "up-or-down",
      order: "endDate",
      ascending: true,
    }),
  ]);
  const seenEventIds = new Set<string>();
  const events: GammaEvent[] = [];
  for (const batch of eventBatches) {
    for (const ev of batch) {
      const id = ev.id ?? ev.slug;
      if (!id || seenEventIds.has(id)) continue;
      seenEventIds.add(id);
      events.push(ev);
    }
  }

  const descriptors: MarketDescriptor[] = [];
  const seenConditionIds = new Set<string>();
  for (const ev of events) {
    if (!isBtc(ev.title) && !isBtc(ev.slug)) continue;
    const tags = (ev.tags ?? []).map((t) => t.slug);
    for (const m of ev.markets ?? []) {
      if (m.closed || !m.active) continue;
      if (seenConditionIds.has(m.conditionId)) continue;
      seenConditionIds.add(m.conditionId);
      descriptors.push(gammaMarketToDescriptor(m, tags));
    }
  }

  const ranked = scoreMarkets(descriptors, thresholds, now, opts.incumbentConditionId ?? null);

  const primary = ranked[0]?.descriptor ?? null;
  const watchlistEntries = ranked.slice(0, Math.max(1, thresholds.watchlistSize + 1));
  const watchlist = watchlistEntries.slice(1).map((r) => r.descriptor);

  const usedIds = new Set<string>();
  if (primary) usedIds.add(primary.conditionId);
  for (const w of watchlist) usedIds.add(w.conditionId);
  const graph = descriptors.filter((d) => !usedIds.has(d.conditionId));

  return { primary, watchlist, graph, ranked };
}
