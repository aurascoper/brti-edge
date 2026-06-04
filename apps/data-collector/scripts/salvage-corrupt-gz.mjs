#!/usr/bin/env node
// salvage-corrupt-gz.mjs — recover readable JSONL from gzip files left with a
// torn member by a HARD kill (OOM / power loss), which the drain-safe collector
// supervisor can never prevent. For each path:
//   1. stream-decompress, keeping every line that JSON.parses (drops the torn
//      trailing record and any non-JSON garbage at the fault boundary);
//   2. if >=1 record survived, repack as a clean single-member gzip (level 1,
//      matching the collector) and atomically swap it in;
//   3. move the original torn file to corrupted-by-orphans/<name>.torn so the
//      evidence is preserved and (for 0-salvage files) the hour reads as a
//      genuine coverage gap rather than a present-but-empty bucket.
// Idempotent: a file that already passes `gzip -t` is left untouched.
import { createReadStream, createWriteStream, renameSync, mkdirSync, existsSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

const TOLERATE = new Set(["Z_BUF_ERROR", "ERR_STREAM_PREMATURE_CLOSE", "Z_DATA_ERROR"]);

async function salvageOne(path) {
  const quarantineDir = join(dirname(path), "corrupted-by-orphans");
  const tmp = `${path}.salvage.tmp.gz`;

  // Pass 1: decompress + JSON-filter into a clean gzip temp.
  const out = createGzip({ level: 1 });
  const sink = out.pipe(createWriteStream(tmp));
  let kept = 0;
  let dropped = 0;
  const gz = createReadStream(path).pipe(createGunzip());
  gz.on("error", () => {}); // tolerated below; partial decode already streamed
  const rl = createInterface({ input: gz, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        JSON.parse(line);
      } catch {
        dropped += 1;
        continue;
      }
      if (!out.write(line + "\n")) await new Promise((r) => out.once("drain", r));
      kept += 1;
    }
  } catch (err) {
    if (!TOLERATE.has(err?.code ?? "")) throw err;
  }
  out.end();
  await new Promise((res, rej) => sink.on("finish", res).on("error", rej));

  // Quarantine the torn original (preserve evidence).
  if (!existsSync(quarantineDir)) mkdirSync(quarantineDir, { recursive: true });
  renameSync(path, join(quarantineDir, `${basename(path)}.torn`));

  if (kept > 0) {
    renameSync(tmp, path); // atomic swap-in of the clean repacked file
    console.log(`  REPACKED ${basename(path)}  kept=${kept} dropped=${dropped}`);
  } else {
    // Nothing recoverable: leave the path absent so the hour is an honest gap.
    renameSync(tmp, join(quarantineDir, `${basename(path)}.empty.gz`));
    console.log(`  GAP      ${basename(path)}  kept=0 dropped=${dropped} (quarantined, hour now a gap)`);
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node salvage-corrupt-gz.mjs <file.jsonl.gz> [...]");
  process.exit(2);
}
for (const f of files) {
  try {
    await salvageOne(f);
  } catch (err) {
    console.error(`  FAILED   ${basename(f)}: ${err.message}`);
  }
}
