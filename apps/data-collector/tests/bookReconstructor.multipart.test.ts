// Candidate tests against bc07ba9ca5a0; run with pnpm exec tsx --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { streamBookEvents, reconstructAll, depthAt } from '../src/replay/bookReconstructor.js';

const hour = '2026-01-01T00';
const t = Date.parse('2026-01-01T00:00:00Z');
const ticker = 'TEST-ONLY';
function row(type: string, offset: number, fields: object, recv = offset) {
  return { recv_ts_ms: t+recv, raw: { type, msg: {
    market_ticker: ticker, market_id: 'test-id', ts_ms: t+offset, ...fields,
  }}};
}
const snap = (offset: number, size: string, recv = offset) => row('orderbook_snapshot', offset,
  {yes_dollars_fp: [['0.4000', size]], no_dollars_fp: [['0.5000', '5']]}, recv);
const delta = (offset: number, size: string, recv = offset) => row('orderbook_delta', offset,
  {side:'yes', price_dollars:'0.4000', delta_fp:size}, recv);
const terminal = (offset: number, recv = offset) => row('orderbook_snapshot', offset, {}, recv);
function gz(dir: string, channel: string, part: string, rows: object[]) {
  writeFileSync(join(dir, `orderbook-${channel}-${hour}${part}.jsonl.gz`),
    gzipSync(rows.map(x=>JSON.stringify(x)).join('\n')+'\n'));
}
async function read(dir: string) {
  const result = [];
  for await (const e of streamBookEvents(dir)) result.push(e);
  return result;
}

test('all crash parts survive and match unsplit chronological oracle', async () => {
  const dir = mkdtempSync(join(tmpdir(),'brti-parts-'));
  const oracle = mkdtempSync(join(tmpdir(),'brti-oracle-'));
  try {
    // Create in deliberately shuffled order; distinct timestamps establish ordering.
    gz(dir,'deltas','.p10',[delta(50,'-1')]);
    gz(dir,'snapshots','.p2',[snap(30,'9')]);
    gz(dir,'deltas','',[delta(20,'2')]);
    gz(dir,'snapshots','',[snap(10,'4')]);
    gz(dir,'deltas','.p2',[delta(40,'3')]);
    gz(oracle,'snapshots','',[snap(10,'4'),snap(30,'9')]);
    gz(oracle,'deltas','',[delta(20,'2'),delta(40,'3'),delta(50,'-1')]);
    const expected = await read(oracle);
    assert.equal(expected.length,5);
    assert.deepEqual(await read(dir),expected);
    const books = await reconstructAll(dir,()=>true,()=>{});
    const book = books.get(ticker)!;
    assert.equal(book.snapshotsApplied,2);
    assert.equal(book.deltasApplied,3);
    assert.equal(depthAt(book,'yes','0.4000'),11);
  } finally { rmSync(dir,{recursive:true,force:true}); rmSync(oracle,{recursive:true,force:true}); }
});

test('part-only hour retains events; ties use receive time then type rank', async () => {
  const dir = mkdtempSync(join(tmpdir(),'brti-ties-'));
  try {
    gz(dir,'snapshots','.p2',[snap(10,'4',10),terminal(10,10)]);
    gz(dir,'deltas','.p2',[delta(10,'2',10)]);
    const events=await read(dir);
    assert.deepEqual(events.map(e=>e.type),['snapshot','delta','snapshot_terminal']);
    const books=await reconstructAll(dir,()=>true,()=>{});
    const book=books.get(ticker)!;
    assert.equal(book.deltasApplied,1);
    assert.equal(book.terminated,true);
    assert.equal(depthAt(book,'yes','0.4000'),6);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
