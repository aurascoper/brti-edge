// Parse Polymarket BTC up/down market slugs to extract T_start (window opening time).
// Patterns observed:
//   btc-updown-5m-1778534400   → unix start, +5min end
//   btc-updown-15m-1778534400  → unix start, +15min end
//   bitcoin-up-or-down-may-11-2026-4pm-et  → calendar form (hourly+)

export interface MarketSpec {
  tStartMs: number | null;
  durationSec: number | null;
}

const UNIX_5M_RE = /btc-updown-5m-(\d{10,})/i;
const UNIX_15M_RE = /btc-updown-15m-(\d{10,})/i;
const UNIX_1M_RE = /btc-updown-1m-(\d{10,})/i;
const CALENDAR_RE =
  /bitcoin-up-or-down-([a-z]+)-(\d{1,2})-(\d{4})-(\d{1,2})(am|pm)-et/i;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export function parseMarketSpec(slug: string, endDateMs: number): MarketSpec {
  const m5 = slug.match(UNIX_5M_RE);
  if (m5) {
    const tStart = Number(m5[1]) * 1000;
    return { tStartMs: tStart, durationSec: 300 };
  }
  const m15 = slug.match(UNIX_15M_RE);
  if (m15) {
    const tStart = Number(m15[1]) * 1000;
    return { tStartMs: tStart, durationSec: 900 };
  }
  const m1 = slug.match(UNIX_1M_RE);
  if (m1) {
    const tStart = Number(m1[1]) * 1000;
    return { tStartMs: tStart, durationSec: 60 };
  }
  const cal = slug.match(CALENDAR_RE);
  if (cal) {
    // Hourly market: ends at the named hour, started 1 hour before.
    const month = MONTHS[cal[1]!.toLowerCase()];
    const day = Number(cal[2]);
    const year = Number(cal[3]);
    let hour24 = Number(cal[4]);
    const ampm = cal[5]!.toLowerCase();
    if (ampm === "pm" && hour24 !== 12) hour24 += 12;
    if (ampm === "am" && hour24 === 12) hour24 = 0;
    // ET is UTC-4 (EDT) or UTC-5 (EST). Polymarket markets in May are EDT (UTC-4).
    if (month !== undefined && Number.isFinite(year)) {
      const endUtc = Date.UTC(year, month, day, hour24 + 4, 0, 0);
      return { tStartMs: endUtc - 3600 * 1000, durationSec: 3600 };
    }
  }
  // Fallback: assume duration from endDate (can't know start)
  return { tStartMs: null, durationSec: null };
}
