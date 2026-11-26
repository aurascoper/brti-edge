import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  auditBookSegments,
  reconstructAll,
  streamBookEvents,
} from '../src/replay/bookReconstructor.js';

const hour = '2026-01-01T00';
const t = Date.parse('2026-01-01T00:00:00Z');
const ticker = 'TEST-ONLY';

function snap(offset: number, size: string) {
  return {
    recv_ts_ms: t + offset,
    raw: {
      type: 'orderbook_snapshot',
      msg: {
        market_ticker: ticker,
        market_id: 'test-id',
        ts_ms: t + offset,
        yes_dollars_fp: [['0.4000', size]],
        no_dollars_fp: [['0.5000', '5']],
      },
    },
  };
}

function delta(offset: number, size: string) {
  return {
    recv_ts_ms: t + offset,
    raw: {
      type: 'orderbook_delta',
      msg: {
        market_ticker: ticker,
        market_id: 'test-id',
        ts_ms: t + offset,
        side: 'yes',
        price_dollars: '0.4000',
        delta_fp: size,
      },
    },
  };
}

test('truncated gzip fails closed by default and only degrades with allowTruncatedGzip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brti-trunc-'));
  try {
    const payload = [snap(10, '4'), snap(20, '8')].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const gz = gzipSync(payload);
    // Truncate inside the compressed body/trailer so gunzip fails with Z_BUF_ERROR.
    const truncated = gz.subarray(0, Math.max(12, gz.length - 8));
    writeFileSync(join(dir, `orderbook-snapshots-${hour}.jsonl.gz`), truncated);

    await assert.rejects(async () => {
      for await (const _ev of streamBookEvents(dir)) {
        // drain
      }
    });

    await assert.rejects(reconstructAll(dir, () => true, () => {}));

    const recovered: unknown[] = [];
    for await (const ev of streamBookEvents(dir, undefined, { allowTruncatedGzip: true })) {
      recovered.push(ev);
    }
    assert.ok(recovered.length <= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0-byte gzip fails closed by default while valid empty gzip succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brti-zero-'));
  try {
    writeFileSync(join(dir, `orderbook-snapshots-${hour}.jsonl.gz`), Buffer.alloc(0));

    await assert.rejects(async () => {
      for await (const _ev of streamBookEvents(dir)) {
        // drain
      }
    });

    const degraded: unknown[] = [];
    for await (const ev of streamBookEvents(dir, undefined, { allowTruncatedGzip: true })) {
      degraded.push(ev);
    }
    assert.equal(degraded.length, 0);

    writeFileSync(join(dir, `orderbook-snapshots-${hour}.jsonl.gz`), gzipSync(''));
    const emptyValid: unknown[] = [];
    for await (const ev of streamBookEvents(dir)) {
      emptyValid.push(ev);
    }
    assert.equal(emptyValid.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('early consumer break cleans up streams without error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brti-early-'));
  try {
    const lines = [snap(10, '4'), snap(20, '8'), snap(30, '2')]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n';
    writeFileSync(join(dir, `orderbook-snapshots-${hour}.jsonl.gz`), gzipSync(lines));

    let count = 0;
    for await (const _ev of streamBookEvents(dir)) {
      count += 1;
      break;
    }
    assert.equal(count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt non-gzip header fails even with allowTruncatedGzip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brti-corrupt-'));
  try {
    writeFileSync(join(dir, `orderbook-deltas-${hour}.jsonl.gz`), Buffer.from('not-a-gzip-stream'));
    await assert.rejects(async () => {
      for await (const _ev of streamBookEvents(dir, undefined, { allowTruncatedGzip: true })) {
        // drain
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auditBookSegments and strictSegments detect missing base and interior parts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brti-gap-'));
  try {
    writeFileSync(
      join(dir, `orderbook-snapshots-${hour}.p2.jsonl.gz`),
      gzipSync(JSON.stringify(snap(10, '4')) + '\n')
    );
    writeFileSync(
      join(dir, `orderbook-deltas-${hour}.jsonl.gz`),
      gzipSync(JSON.stringify(delta(20, '2')) + '\n')
    );
    writeFileSync(
      join(dir, `orderbook-deltas-${hour}.p3.jsonl.gz`),
      gzipSync(JSON.stringify(delta(30, '1')) + '\n')
    );

    const audit = auditBookSegments(dir);
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0]?.snapshotParts, [2]);
    assert.deepEqual(audit[0]?.missingSnapshotParts, [1]);
    assert.deepEqual(audit[0]?.deltaParts, [1, 3]);
    assert.deepEqual(audit[0]?.missingDeltaParts, [2]);

    await assert.rejects(
      async () => {
        for await (const _ev of streamBookEvents(dir, undefined, { strictSegments: true })) {
          // drain
        }
      },
      /Missing segment\(s\) in hour 2026-01-01T00/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
