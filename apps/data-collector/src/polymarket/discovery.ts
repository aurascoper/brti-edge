// Gamma discovery for Polymarket up/down markets (Phase 0 tape archiver).
//
// Two-batch pagination pattern copied from
// packages/polymarket-client/src/gamma/resolveBtcMarkets.ts (resolveBtcMarkets):
//   - tag_slug=crypto, limit 80, order volume24hr desc — catches high-volume
//     events that carry the up-or-down tag but rank late in the endDate sort.
//   - tag_slug=up-or-down, limit 250, order endDate asc — the API returns
//     ~95 stale-but-active expired markets before reaching current
//     short-duration markets when sorted ascending by endDate, so the limit
//     must be high enough to page past them.
// We copy the pattern rather than calling resolveBtcMarkets because that
// function ranks/filters for the trading worker (yes-price bands, watchlist
// scoring); the archiver wants EVERY current up/down market per asset.

import {
  defaultEndpoints,
  fetchEvents,
  fetchMarkets,
  type GammaEvent,
  type GammaEventMarket,
} from "@polyterminal/polymarket-client";

// Gamma market rows carry more fields than the client's GammaEventMarket
// interface declares; the extras survive JSON parsing, we just widen the type.
export interface GammaUpDownMarket extends GammaEventMarket {
  negRisk?: boolean;
  fee?: number | string;
  makerBaseFee?: number | string;
  takerBaseFee?: number | string;
  orderPriceMinTickSize?: number | string;
  orderMinSize?: number | string;
  umaResolutionStatus?: string;
}

export interface TrackedMarket {
  asset: string; // btc | eth | sol | ...
  slug: string;
  conditionId: string;
  question: string;
  tokenIds: string[]; // parsed clobTokenIds, [yes, no] order as served
  outcomes: string[];
  endDate: string | null;
  negRisk: boolean | null;
  fee: number | string | null;
  makerBaseFee: number | string | null;
  takerBaseFee: number | string | null;
  orderPriceMinTickSize: number | string | null;
  orderMinSize: number | string | null;
  eventSlug: string;
  eventTitle: string;
}

// Title/slug regexes per asset. \bsol\b will not match inside "solana", so
// both forms are listed explicitly.
const ASSET_PATTERNS: Record<string, RegExp> = {
  btc: /\bbtc\b|\bbitcoin\b/i,
  eth: /\beth\b|\bethereum\b/i,
  sol: /\bsol\b|\bsolana\b/i,
};

export function assetPattern(asset: string): RegExp {
  return ASSET_PATTERNS[asset] ?? new RegExp(`\\b${asset}\\b`, "i");
}

export function parseAssets(raw: string | undefined): string[] {
  return (raw ?? "btc,eth,sol")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Copied helper pattern from resolveBtcMarkets.ts (module-private there).
function parseJsonList<T>(s: string | undefined): T[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isUpDownEvent(ev: GammaEvent): boolean {
  if ((ev.tags ?? []).some((t) => t.slug === "up-or-down")) return true;
  return /up-or-down/i.test(ev.slug);
}

function matchAsset(ev: GammaEvent, assets: string[]): string | null {
  for (const asset of assets) {
    const p = assetPattern(asset);
    if (p.test(ev.title) || p.test(ev.slug)) return asset;
  }
  return null;
}

export async function discoverUpDownMarkets(
  assets: string[],
  now = Date.now(),
): Promise<TrackedMarket[]> {
  const eventBatches = await Promise.all([
    fetchEvents({
      active: true,
      closed: false,
      limit: 80,
      tagSlug: "crypto",
      order: "volume24hr",
      ascending: false,
    }),
    fetchEvents({
      active: true,
      closed: false,
      limit: 250,
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

  const out: TrackedMarket[] = [];
  const seenConditionIds = new Set<string>();
  for (const ev of events) {
    if (!isUpDownEvent(ev)) continue;
    const asset = matchAsset(ev, assets);
    if (!asset) continue;
    for (const m of (ev.markets ?? []) as GammaUpDownMarket[]) {
      if (m.closed || !m.active) continue;
      if (seenConditionIds.has(m.conditionId)) continue;
      // The up-or-down batch is sorted ascending by endDate precisely
      // because expired markets are still flagged active; drop them here.
      if (m.endDate) {
        const end = Date.parse(m.endDate);
        if (Number.isFinite(end) && end <= now) continue;
      }
      const tokenIds = parseJsonList<string>(m.clobTokenIds);
      if (tokenIds.length < 2) continue; // need both clob tokens to subscribe
      seenConditionIds.add(m.conditionId);
      out.push({
        asset,
        slug: m.slug,
        conditionId: m.conditionId,
        question: m.question,
        tokenIds,
        outcomes: parseJsonList<string>(m.outcomes),
        endDate: m.endDate ?? null,
        negRisk: m.negRisk ?? null,
        fee: m.fee ?? null,
        makerBaseFee: m.makerBaseFee ?? null,
        takerBaseFee: m.takerBaseFee ?? null,
        orderPriceMinTickSize: m.orderPriceMinTickSize ?? null,
        orderMinSize: m.orderMinSize ?? null,
        eventSlug: ev.slug,
        eventTitle: ev.title,
      });
    }
  }
  return out;
}

// Settlement sweep support: fetch gamma market rows for a set of condition
// ids (chunked — gamma accepts repeated condition_ids params).
const SWEEP_CHUNK = 20;

export async function fetchMarketsByConditionIds(
  conditionIds: string[],
): Promise<GammaUpDownMarket[]> {
  const out: GammaUpDownMarket[] = [];
  for (let i = 0; i < conditionIds.length; i += SWEEP_CHUNK) {
    const chunk = conditionIds.slice(i, i + SWEEP_CHUNK);
    const rows = await fetchMarkets({ conditionIds: chunk }, defaultEndpoints);
    for (const r of rows as GammaUpDownMarket[]) out.push(r);
  }
  return out;
}

// A market counts as resolved when UMA says so, or when it is closed with a
// degenerate outcome-price vector (one outcome pinned at ~1).
export interface ResolutionView {
  resolved: boolean;
  winningOutcome: string | null;
  outcomePrices: number[];
}

export function resolutionOf(m: GammaUpDownMarket, outcomes: string[]): ResolutionView {
  const prices = parseJsonList<string>(m.outcomePrices).map((p) => Number(p));
  const winIdx = prices.findIndex((p) => Number.isFinite(p) && p >= 0.999);
  const uma = (m.umaResolutionStatus ?? "").toLowerCase() === "resolved";
  const resolved = uma || (!!m.closed && winIdx >= 0);
  return {
    resolved,
    winningOutcome: resolved && winIdx >= 0 ? (outcomes[winIdx] ?? null) : null,
    outcomePrices: prices,
  };
}
