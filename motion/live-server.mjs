// live-server.mjs — read-only feed for the live edge board (live.html).
//
// Serves:
//   GET /            → live.html
//   GET /api/board   → { now, holdoutStartMs, state, markets }
//
// `state` proxies the worker's /kalshi/state (:4001). `markets` is the latest
// shadow-log row per ticker (the endpoint's recentCandidates omit SKIPs, which
// is most of what a truthful board shows). Reads only the log tail each poll.
//
// Deliberately OUTSIDE the frozen scoring path: consumes logs, writes nothing.
//
// Run:  node live-server.mjs   → http://localhost:4180
import { createServer } from "node:http";
import { openSync, readSync, fstatSync, closeSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHADOW_LOG = join(HERE, "..", "apps", "market-worker", "logs", "kalshi-shadow.jsonl");
const WORKER_STATE_URL = "http://127.0.0.1:4001/kalshi/state";
const PORT = Number(process.env.LIVE_BOARD_PORT ?? 4180);
const TAIL_BYTES = 256 * 1024;

function tailRows() {
  let fd;
  try {
    fd = openSync(SHADOW_LOG, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // first line may be a partial record
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* mid-write row */ }
    }
    return rows;
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function latestPerTicker(rows, nowMs) {
  const byTicker = new Map();
  for (const r of rows) byTicker.set(r.ticker, r); // rows are append-ordered
  const out = [];
  for (const r of byTicker.values()) {
    const ts = Date.parse(r.ts);
    const closeMs = ts + (r.secs_to_close ?? 0) * 1000;
    if (closeMs > nowMs - 30_000) out.push({ ...r, close_ms: closeMs, row_age_ms: nowMs - ts });
  }
  return out.sort((a, b) => a.series.localeCompare(b.series) || a.close_ms - b.close_ms);
}

const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/live.html") {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(join(HERE, "live.html")));
    } catch { res.writeHead(500); res.end("live.html missing"); }
    return;
  }
  if (req.url === "/api/board") {
    const now = Date.now();
    let state = null;
    try {
      const r = await fetch(WORKER_STATE_URL, { signal: AbortSignal.timeout(3000) });
      state = await r.json();
    } catch { /* worker down → board shows FEED STALE */ }
    let holdoutStartMs = null;
    try { holdoutStartMs = statSync(SHADOW_LOG).birthtimeMs; } catch { /* no log yet */ }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ now, holdoutStartMs, state, markets: latestPerTicker(tailRows(), now) }));
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[live-board] http://localhost:${PORT}  (shadow log: ${SHADOW_LOG})`),
);
