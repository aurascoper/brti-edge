// Per-channel gzip-rotated JSONL writer.
//
// One file per (channel, UTC hour). On rotation:
//   - the previous-hour gzip stream is end()ed cleanly so the file is a
//     valid standalone .gz
//   - a new file is opened for the new hour
//
// We use streaming zlib.createGzip piped into a fs.WriteStream. zlib's
// gzip stream emits a valid trailer only on .end(); we never reopen a
// closed file. New hour = new file = new gzip stream.
//
// Durability: we call gz.flush(zlib.constants.Z_SYNC_FLUSH) every
// FLUSH_INTERVAL_MS so a crash loses at most that many seconds of buffered
// data per channel. Without flush, gzip buffers ~32KB by default and we
// could lose minutes of low-volume channels on a hard kill.

import { createWriteStream, mkdirSync, existsSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { createGzip, constants as zlibConstants, type Gzip } from "node:zlib";

const FLUSH_INTERVAL_MS = 5_000;

interface ChannelState {
  gz: Gzip;
  file: WriteStream;
  hour: string; // YYYY-MM-DDTHH
  bytesWritten: number;
  linesWritten: number;
  openedAt: number;
}

function utcHour(now: Date = new Date()): string {
  // YYYY-MM-DDTHH (UTC)
  return now.toISOString().slice(0, 13);
}

export interface RotatorOptions {
  logDir: string;
  channel: string;
}

export class GzipRotator {
  private state: ChannelState | null = null;
  private readonly logDir: string;
  private readonly channel: string;
  private closed = false;

  constructor(opts: RotatorOptions) {
    this.logDir = opts.logDir;
    this.channel = opts.channel;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  write(obj: unknown): void {
    if (this.closed) return;
    const hour = utcHour();
    if (!this.state || this.state.hour !== hour) {
      this.rotate(hour);
    }
    const line = JSON.stringify(obj) + "\n";
    const ok = this.state!.gz.write(line);
    if (!ok) {
      // Backpressure: gzip stream buffer is full. We don't pause the WS
      // (event loss is worse than memory growth here), but emit a
      // diagnostic. If sustained, this is a sign the disk is too slow.
      console.warn(`[data-collector] ${this.channel} gzip backpressure`);
    }
    this.state!.bytesWritten += line.length;
    this.state!.linesWritten += 1;
  }

  private rotate(hour: string): void {
    if (this.state) {
      const prev = this.state;
      // Cleanly end the previous gzip; the file becomes a valid .gz.
      prev.gz.end();
    }
    const filename = `${this.channel}-${hour}.jsonl.gz`;
    const path = resolve(this.logDir, filename);
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const file = createWriteStream(path, { flags: "a" });
    const gz = createGzip({ level: 6 });
    gz.pipe(file);
    this.state = {
      gz,
      file,
      hour,
      bytesWritten: 0,
      linesWritten: 0,
      openedAt: Date.now(),
    };
  }

  flush(): void {
    if (!this.state || this.closed) return;
    this.state.gz.flush(zlibConstants.Z_SYNC_FLUSH);
  }

  stats(): { hour: string | null; bytes: number; lines: number } {
    if (!this.state) return { hour: null, bytes: 0, lines: 0 };
    return {
      hour: this.state.hour,
      bytes: this.state.bytesWritten,
      lines: this.state.linesWritten,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.state) {
      this.state.gz.end();
      this.state = null;
    }
  }

  // Async close that waits for the gzip trailer to land on disk.
  // gz.end() is asynchronous: it signals end-of-input but the underlying
  // file stream still needs to flush the gzip trailer (CRC32 + size).
  // Returns when the file stream emits 'finish', or after a 3s safety
  // timeout so a hung stream never blocks shutdown forever.
  closeAsync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (!this.state) return Promise.resolve();
    const file = this.state.file;
    const gz = this.state.gz;
    this.state = null;
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      file.once("finish", finish);
      file.once("error", finish);
      setTimeout(finish, 3_000);
      gz.end();
    });
  }
}

export class MultiChannelRotator {
  private readonly rotators = new Map<string, GzipRotator>();
  private readonly logDir: string;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(logDir: string) {
    this.logDir = logDir;
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  write(channel: string, obj: unknown): void {
    let r = this.rotators.get(channel);
    if (!r) {
      r = new GzipRotator({ logDir: this.logDir, channel });
      this.rotators.set(channel, r);
    }
    r.write(obj);
  }

  flushAll(): void {
    for (const r of this.rotators.values()) r.flush();
  }

  statsByChannel(): Record<string, { hour: string | null; bytes: number; lines: number }> {
    const out: Record<string, ReturnType<GzipRotator["stats"]>> = {};
    for (const [name, r] of this.rotators) out[name] = r.stats();
    return out;
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const r of this.rotators.values()) r.close();
    this.rotators.clear();
  }

  // Async close: waits for ALL channel gzip trailers to flush. Use this
  // in signal handlers so the process doesn't exit() before the .gz files
  // are valid.
  async closeAsync(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await Promise.all(Array.from(this.rotators.values()).map((r) => r.closeAsync()));
    this.rotators.clear();
  }
}
