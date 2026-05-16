import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  resolveBtcMarkets,
  fetchBook,
  connectMarketWs,
  type RankedMarket,
} from "@polyterminal/polymarket-client";
import { applyPriceChanges, buildSnapshot, buildGraph } from "@polyterminal/market-state";
import type {
  MarketDescriptor,
  MarketSnapshot,
  OrderBook,
  TerminalSnapshot,
} from "@polyterminal/types";
import WebSocket from "ws";
import { SeriesStore } from "./history/series";
import { fetchPrimaryHistoryPoints } from "./history/fetchPrimaryHistory";
import { RingBuffer } from "./state/ringBuffer";
import { momentum } from "./strategy/momentum";
import { meanReversion } from "./strategy/meanReversion";
import { naiveYes } from "./strategy/naiveYes";
import { fairValueArb } from "./strategy/fairValueArb";
import { fairValueArbCapped } from "./strategy/fairValueArbCapped";
import { fairValueArbCappedTight } from "./strategy/fairValueArbCappedTight";
import { ShadowLogger } from "./strategy/shadowLogger";
import { OutcomeTracker } from "./strategy/outcomeTracker";
import { parseMarketSpec } from "./strategy/marketSpec";
import { DustExecutor } from "./execution/dustExecutor";
import type { TickPoint } from "./strategy/types";

const PORT = Number(process.env.WORKER_PORT ?? 4000);
const REFRESH_MARKETS_MS = 30_000;
const SNAPSHOT_PUBLISH_MS = 1_000;
const HYSTERESIS_RATIO = 1.15;

const SHORT_DURATION_MAX_SECS = 15 * 60;
const SHADOW_YES_MIN = Number(process.env.POLYTERMINAL_SHADOW_YES_MIN ?? "0.02");
const SHADOW_YES_MAX = Number(process.env.POLYTERMINAL_SHADOW_YES_MAX ?? "0.98");
const SHADOW_DECISIONS_LOG = resolve(process.cwd(), "logs/shadow-decisions.jsonl");
const SHADOW_OUTCOMES_LOG = resolve(process.cwd(), "logs/shadow-outcomes.jsonl");
const DUST_STATE_FILE = resolve(process.cwd(), "logs/dust-state.json");
const DUST_CANDIDATES_LOG = resolve(process.cwd(), "logs/dust-candidates.jsonl");
const OUTCOME_POLL_MS = 30_000;
const DUST_EXPIRE_POLL_MS = 10_000;
// Capacity must cover ~30 min of Binance trades so we can read S_ref at T_start
// for 15-min markets even when we first observe them mid-window. At ~4 ticks/sec,
// 8000 entries ≈ 33 min of headroom.
const BTC_TAPE_CAPACITY = 8000;
const REALIZED_VOL_WINDOW_SEC = 300;
const SECONDS_PER_YEAR = 365 * 24 * 3600;

const shadowLogger = new ShadowLogger(
  [momentum, meanReversion, naiveYes, fairValueArb, fairValueArbCapped, fairValueArbCappedTight],
  SHADOW_DECISIONS_LOG,
);
const outcomeTracker = new OutcomeTracker(SHADOW_OUTCOMES_LOG, SHADOW_DECISIONS_LOG);
const dustExecutor = new DustExecutor(DUST_STATE_FILE, DUST_CANDIDATES_LOG);
const btcTape = new RingBuffer(BTC_TAPE_CAPACITY);

function tapeSnapshot(): TickPoint[] {
  return btcTape.snapshot().map((p) => ({ ts: p.ts, price: p.value }));
}

function priceAt(tape: TickPoint[], tsMs: number): number | null {
  if (tape.length === 0) return null;
  // Linear scan acceptable; tape is small.
  let best: TickPoint | null = null;
  let bestDelta = Infinity;
  for (const p of tape) {
    const d = Math.abs(p.ts - tsMs);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  if (!best) return null;
  // Reject if the nearest tick is more than 60s from the requested time.
  if (bestDelta > 60_000) return null;
  return best.price;
}

function realizedVolAnnualized(tape: TickPoint[], nowMs: number, windowSec: number): number | null {
  const cutoff = nowMs - windowSec * 1000;
  const window = tape.filter((p) => p.ts >= cutoff);
  if (window.length < 30) return null;
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1]!.price;
    const b = window[i]!.price;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 30) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const stdPerStep = Math.sqrt(variance);
  // Average step duration in seconds
  const spanSec = (window[window.length - 1]!.ts - window[0]!.ts) / 1000;
  const stepsPerSec = rets.length / Math.max(1, spanSec);
  // Annualize: σ_annual = σ_step × √(stepsPerSec × secondsPerYear)
  return stdPerStep * Math.sqrt(stepsPerSec * SECONDS_PER_YEAR);
}

function isShortDurationBtc(d: MarketDescriptor, nowMs: number): boolean {
  if (!d.endDateIso) return false;
  const end = Date.parse(d.endDateIso);
  if (!Number.isFinite(end)) return false;
  const secs = (end - nowMs) / 1000;
  if (secs <= 0 || secs > SHORT_DURATION_MAX_SECS) return false;
  const slug = d.slug.toLowerCase();
  const title = d.question.toLowerCase();
  const slugOrTitleMatches =
    /btc-updown|bitcoin-up-or-down/.test(slug) || /bitcoin up or down/.test(title);
  if (!slugOrTitleMatches) return false;
  // Only fire after the market has opened (T_start ≤ now + 30s tolerance).
  // Polymarket publishes 5-min markets ahead of time; firing pre-open means S_ref is unobtainable.
  const spec = parseMarketSpec(d.slug, end);
  if (spec.tStartMs !== null && spec.tStartMs > nowMs + 30_000) return false;
  // Shadow-collection YES eligibility (wider than main hero/watchlist).
  const yesPrice = d.tokens[0]?.price;
  if (yesPrice === undefined || !Number.isFinite(yesPrice)) return false;
  if (yesPrice < SHADOW_YES_MIN || yesPrice > SHADOW_YES_MAX) return false;
  return true;
}

function fireShadowFor(d: MarketDescriptor, nowMs: number): void {
  const yesToken = d.tokens[0]?.tokenId;
  const book = yesToken ? state.books.get(yesToken) ?? null : null;
  const snap = buildSnapshot({
    market: d,
    yesBook: book,
    noBook: null,
    btcReference: state.btcReference,
    fairValue: null,
    now: nowMs,
  });
  const endDate = d.endDateIso ? Date.parse(d.endDateIso) : 0;
  const tape = tapeSnapshot();
  const spec = parseMarketSpec(d.slug, endDate);
  const sRef = spec.tStartMs !== null ? priceAt(tape, spec.tStartMs) : null;
  const sCurrent = state.btcReference;
  const sigmaAnnual = realizedVolAnnualized(tape, nowMs, REALIZED_VOL_WINDOW_SEC);

  const row = shadowLogger.fire({
    marketId: d.conditionId,
    marketSlug: d.slug,
    endDateMs: endDate,
    tStartMs: spec.tStartMs,
    nowMs,
    midYes: snap.midpointYes,
    bestBidYes: snap.bestBidYes,
    bestAskYes: snap.bestAskYes,
    bookAgeSec: snap.bookAgeSec,
    btcRef: state.btcReference,
    btcTape: tape,
    sRef,
    sCurrent,
    sigmaAnnual,
  });
  if (row) {
    outcomeTracker.add(row);
    dustExecutor.evaluate(row);
  }
}

interface State {
  primaryDescriptor: MarketDescriptor | null;
  primaryScore: number | null;
  watchlistDescriptors: MarketDescriptor[];
  graphDescriptors: MarketDescriptor[];
  scoreByConditionId: Map<string, number>;
  books: Map<string, OrderBook>;
  btcReference: number | null;
  series: SeriesStore;
  manualPrimaryConditionId: string | null;
  lastSnapshot: TerminalSnapshot;
}

const state: State = {
  primaryDescriptor: null,
  primaryScore: null,
  watchlistDescriptors: [],
  graphDescriptors: [],
  scoreByConditionId: new Map(),
  books: new Map(),
  btcReference: null,
  series: new SeriesStore(3_600),
  manualPrimaryConditionId: null,
  lastSnapshot: {
    primary: null,
    watchlist: [],
    related: [],
    graph: { nodes: [], edges: [] },
    primarySeries: { midpointYes: [], btcReference: [], spreadYes: [] },
    equitySeries: [],
    primaryScore: null,
    primaryMode: "auto",
    manualPrimaryConditionId: null,
    updatedAt: 0,
  },
};

let wsHandle: { close: () => void } | null = null;

async function refreshMarkets(): Promise<void> {
  try {
    const previousId = state.primaryDescriptor?.conditionId ?? null;
    const result = await resolveBtcMarkets({
      incumbentConditionId: previousId,
    });
    const { ranked, watchlist, graph } = result;

    const chosen = applyHysteresis(ranked);
    const switched = chosen.descriptor?.conditionId !== previousId;

    state.primaryDescriptor = chosen.descriptor;
    state.primaryScore = chosen.score;
    state.scoreByConditionId = new Map(
      ranked.map((r) => [r.descriptor.conditionId, r.score]),
    );

    state.watchlistDescriptors = watchlist.filter(
      (w) => w.conditionId !== chosen.descriptor?.conditionId,
    );
    state.graphDescriptors = graph;

    // Seed books only for primary + watchlist. Graph tail is purely visual; no books needed.
    const tradableDescriptors = [
      ...(chosen.descriptor ? [chosen.descriptor] : []),
      ...state.watchlistDescriptors,
    ];
    const subscribed = collectTokenIds(tradableDescriptors);
    await seedBooks(subscribed);
    reconnectWs(subscribed);

    if (switched && chosen.descriptor?.tokens[0]?.tokenId) {
      state.series.seedMidpoint([]);
      seedPrimaryHistory(chosen.descriptor.tokens[0].tokenId);
    }

    console.log(
      `[market-worker] refreshed: primary=${chosen.descriptor?.slug ?? "none"} ` +
        `score=${chosen.score?.toFixed(3) ?? "—"} ` +
        `yes=${chosen.yesPrice?.toFixed(3) ?? "—"} ` +
        `watchlist=${state.watchlistDescriptors.length} graph=${state.graphDescriptors.length} ` +
        `reason=${chosen.reason} ${switched ? "(switched)" : "(kept)"}`,
    );

    const nowMs = Date.now();
    const allDescriptors: MarketDescriptor[] = [
      ...(chosen.descriptor ? [chosen.descriptor] : []),
      ...state.watchlistDescriptors,
      ...state.graphDescriptors,
    ];
    setTimeout(() => {
      const t = Date.now();
      for (const d of allDescriptors) {
        if (isShortDurationBtc(d, t)) fireShadowFor(d, t);
      }
    }, 2_500);
    void nowMs;
  } catch (err) {
    console.error("[market-worker] refreshMarkets failed", err);
  }
}

type ChosenReason =
  | "cold-start"
  | "kept-incumbent-is-top"
  | "kept-hysteresis"
  | "switched-dethroned"
  | "switched-incumbent-fell-out"
  | "manual-override"
  | "manual-fell-out-reverted";

interface ChosenPrimary {
  descriptor: MarketDescriptor | null;
  score: number | null;
  yesPrice: number | null;
  reason: ChosenReason | "none";
}

function applyHysteresis(ranked: RankedMarket[]): ChosenPrimary {
  if (state.manualPrimaryConditionId) {
    const manual = ranked.find(
      (r) => r.descriptor.conditionId === state.manualPrimaryConditionId,
    );
    if (manual) {
      return {
        descriptor: manual.descriptor,
        score: manual.score,
        yesPrice: manual.yesPrice,
        reason: "manual-override",
      };
    }
    console.warn(
      `[market-worker] manual override ${state.manualPrimaryConditionId} no longer eligible; reverting to auto`,
    );
    state.manualPrimaryConditionId = null;
    state.primaryScore = null;
    const top = ranked[0];
    if (!top) return { descriptor: null, score: null, yesPrice: null, reason: "none" };
    return {
      descriptor: top.descriptor,
      score: top.score,
      yesPrice: top.yesPrice,
      reason: "manual-fell-out-reverted",
    };
  }

  const top = ranked[0];
  if (!top) {
    return { descriptor: null, score: null, yesPrice: null, reason: "none" };
  }

  const currentId = state.primaryDescriptor?.conditionId ?? null;
  const currentScore = state.primaryScore;

  if (currentId === null || currentScore === null) {
    return {
      descriptor: top.descriptor,
      score: top.score,
      yesPrice: top.yesPrice,
      reason: "cold-start",
    };
  }

  const incumbent = ranked.find((r) => r.descriptor.conditionId === currentId);
  if (!incumbent) {
    return {
      descriptor: top.descriptor,
      score: top.score,
      yesPrice: top.yesPrice,
      reason: "switched-incumbent-fell-out",
    };
  }
  if (incumbent.descriptor.conditionId === top.descriptor.conditionId) {
    return {
      descriptor: incumbent.descriptor,
      score: incumbent.score,
      yesPrice: incumbent.yesPrice,
      reason: "kept-incumbent-is-top",
    };
  }
  if (top.score < currentScore * HYSTERESIS_RATIO) {
    return {
      descriptor: incumbent.descriptor,
      score: incumbent.score,
      yesPrice: incumbent.yesPrice,
      reason: "kept-hysteresis",
    };
  }
  return {
    descriptor: top.descriptor,
    score: top.score,
    yesPrice: top.yesPrice,
    reason: "switched-dethroned",
  };
}

function setManualPrimary(conditionId: string | null): void {
  if (conditionId === state.manualPrimaryConditionId) return;
  state.manualPrimaryConditionId = conditionId;
  state.series.seedMidpoint([]);
  if (conditionId === null) {
    state.primaryScore = null;
    state.primaryDescriptor = null;
  }
  void refreshMarkets();
}

function collectTokenIds(markets: Array<MarketDescriptor | null>): string[] {
  const ids: string[] = [];
  for (const m of markets) {
    if (!m) continue;
    for (const t of m.tokens) if (t.tokenId) ids.push(t.tokenId);
  }
  return ids;
}

async function seedBooks(tokenIds: string[]): Promise<void> {
  await Promise.all(
    tokenIds.map(async (id) => {
      try {
        const book = await fetchBook(id);
        state.books.set(id, book);
      } catch (err) {
        console.warn(`[market-worker] book seed failed for ${id}`, err);
      }
    }),
  );
}

function reconnectWs(tokenIds: string[]): void {
  wsHandle?.close();
  if (tokenIds.length === 0) return;
  wsHandle = connectMarketWs({
    assetIds: tokenIds,
    WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
    onOpen: () => console.log(`[market-worker] WS open: ${tokenIds.length} assets`),
    onClose: () => console.log("[market-worker] WS closed"),
    onError: (err) => console.warn("[market-worker] WS error", err),
    onMessage: (msg) => {
      if (msg.event_type === "book") {
        state.books.set(msg.asset_id, {
          tokenId: msg.asset_id,
          bids: msg.bids
            .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
            .filter((l) => l.size > 0)
            .sort((a, b) => b.price - a.price),
          asks: msg.asks
            .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
            .filter((l) => l.size > 0)
            .sort((a, b) => a.price - b.price),
          timestamp: Number(msg.timestamp) || Date.now(),
        });
      } else if (msg.event_type === "price_change") {
        const existing = state.books.get(msg.asset_id);
        if (!existing) return;
        state.books.set(
          msg.asset_id,
          applyPriceChanges(existing, msg.changes, Number(msg.timestamp) || Date.now()),
        );
      }
    },
  });
}

async function seedPrimaryHistory(yesTokenId: string): Promise<void> {
  try {
    const points = await fetchPrimaryHistoryPoints(yesTokenId, "1h", 60);
    if (points.length > 0) {
      state.series.seedMidpoint(points);
      console.log(`[market-worker] seeded ${points.length} history points for primary`);
    }
  } catch (err) {
    console.warn("[market-worker] history seed failed", err);
  }
}

function publishSnapshot(): void {
  const now = Date.now();
  const primary = state.primaryDescriptor ? toSnapshot(state.primaryDescriptor, now) : null;
  const watchlist = state.watchlistDescriptors.map((d) => toSnapshot(d, now));
  const graphMarkets = state.graphDescriptors.map((d) => toSnapshot(d, now));
  const related = [...watchlist, ...graphMarkets];
  const graph = buildGraph(primary, related);

  state.series.append(
    now,
    primary?.midpointYes ?? null,
    primary?.spreadYes ?? null,
    state.btcReference,
  );

  state.lastSnapshot = {
    primary,
    watchlist,
    related,
    graph,
    primarySeries: state.series.primary(),
    equitySeries: state.series.equitySnapshot(),
    primaryScore: state.primaryScore,
    primaryMode: state.manualPrimaryConditionId ? "manual" : "auto",
    manualPrimaryConditionId: state.manualPrimaryConditionId,
    updatedAt: now,
  };
}

function toSnapshot(desc: MarketDescriptor, now: number): MarketSnapshot {
  const yesToken = desc.tokens[0]?.tokenId;
  const noToken = desc.tokens[1]?.tokenId;
  return buildSnapshot({
    market: desc,
    yesBook: yesToken ? state.books.get(yesToken) ?? null : null,
    noBook: noToken ? state.books.get(noToken) ?? null : null,
    btcReference: state.btcReference,
    fairValue: null,
    score: state.scoreByConditionId.get(desc.conditionId) ?? null,
    now,
  });
}

function startBtcRef(): void {
  const url = process.env.BINANCE_BTC_WS ?? "wss://stream.binance.com:9443/ws/btcusdt@trade";
  let ws: WebSocket | null = null;
  const open = () => {
    ws = new WebSocket(url);
    ws.on("open", () => console.log("[market-worker] BTC ref open"));
    ws.on("message", (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as { p?: string };
        if (parsed.p) {
          const px = Number(parsed.p);
          if (Number.isFinite(px)) {
            state.btcReference = px;
            btcTape.append(Date.now(), px);
          }
        }
      } catch {}
    });
    ws.on("close", () => {
      console.warn("[market-worker] BTC ref closed; reconnecting in 3s");
      setTimeout(open, 3_000);
    });
    ws.on("error", (err) => console.warn("[market-worker] BTC ref error", err));
  };
  open();
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function startServer(): void {
  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (req.url.startsWith("/health")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, updatedAt: state.lastSnapshot.updatedAt }));
      return;
    }
    if (req.url.startsWith("/snapshot")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.lastSnapshot));
      return;
    }
    if (req.url.startsWith("/primary") && req.method === "POST") {
      try {
        const body = (await readJson(req)) as { conditionId?: string; auto?: boolean };
        if (body.auto === true) {
          setManualPrimary(null);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, mode: "auto" }));
          return;
        }
        if (typeof body.conditionId === "string" && body.conditionId.length > 0) {
          setManualPrimary(body.conditionId);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, mode: "manual", conditionId: body.conditionId }));
          return;
        }
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "expected { conditionId } or { auto: true }" }));
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (req.url.startsWith("/dust/state") && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(dustExecutor.getState()));
      return;
    }
    if (req.url === "/dust/test-candidate" && req.method === "POST") {
      try {
        const body = (await readJson(req)) as Parameters<typeof dustExecutor.injectTest>[0];
        const result = dustExecutor.injectTest(body ?? {});
        res.statusCode = result.ok ? 200 : 403;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    const dustConfirm = req.url.match(/^\/dust\/confirm\/([\w-]+)$/);
    if (dustConfirm && req.method === "POST") {
      const result = dustExecutor.confirm(dustConfirm[1]!);
      res.statusCode = result.ok ? 200 : 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    const dustDecline = req.url.match(/^\/dust\/decline\/([\w-]+)$/);
    if (dustDecline && req.method === "POST") {
      const result = dustExecutor.decline(dustDecline[1]!);
      res.statusCode = result.ok ? 200 : 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    const dustSubmitted = req.url.match(/^\/dust\/submitted\/([\w-]+)$/);
    if (dustSubmitted && req.method === "POST") {
      try {
        const body = (await readJson(req)) as { signedOrderId?: string | null };
        const result = dustExecutor.recordSubmission(dustSubmitted[1]!, body.signedOrderId ?? null);
        res.statusCode = result.ok ? 200 : 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    const dustResolved = req.url.match(/^\/dust\/resolved\/([\w-]+)$/);
    if (dustResolved && req.method === "POST") {
      try {
        const body = (await readJson(req)) as { pnl?: number; filled?: boolean };
        if (typeof body.pnl !== "number" || typeof body.filled !== "boolean") {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "expected { pnl, filled }" }));
          return;
        }
        const result = dustExecutor.recordResolution(dustResolved[1]!, body.pnl, body.filled);
        res.statusCode = result.ok ? 200 : 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(PORT, () => console.log(`[market-worker] http listening on :${PORT}`));
}

async function main(): Promise<void> {
  startServer();
  startBtcRef();
  await refreshMarkets();
  setInterval(refreshMarkets, REFRESH_MARKETS_MS);
  setInterval(publishSnapshot, SNAPSHOT_PUBLISH_MS);
  setInterval(() => {
    void outcomeTracker.resolveDue(Date.now());
  }, OUTCOME_POLL_MS);
  setInterval(() => dustExecutor.expireStale(), DUST_EXPIRE_POLL_MS);
  setInterval(() => {
    const points = btcTape.snapshot();
    const now = Date.now();
    const recent30 = points.filter((p) => p.ts >= now - 30_000).length;
    const last = points[points.length - 1];
    const ageSec = last ? (now - last.ts) / 1000 : null;
    console.log(
      `[btc-tape] size=${points.length} recent30s=${recent30} ` +
        `last=${ageSec !== null ? ageSec.toFixed(1) + "s ago @ $" + last!.value.toFixed(2) : "(empty)"}`,
    );
  }, 30_000);
}

main().catch((err) => {
  console.error("[market-worker] fatal", err);
  process.exit(1);
});
