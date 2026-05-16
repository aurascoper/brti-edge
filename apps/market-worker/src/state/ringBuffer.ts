import type { TimePoint } from "@polyterminal/types";

export class RingBuffer {
  private points: TimePoint[] = [];

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
  }

  append(ts: number, value: number): void {
    if (!Number.isFinite(value)) return;
    const last = this.points[this.points.length - 1];
    if (last && last.ts === ts) {
      last.value = value;
      return;
    }
    this.points.push({ ts, value });
    if (this.points.length > this.capacity) this.points.shift();
  }

  seed(points: TimePoint[]): void {
    const sorted = [...points].sort((a, b) => a.ts - b.ts);
    const trimmed = sorted.slice(-this.capacity);
    this.points = trimmed;
  }

  snapshot(): TimePoint[] {
    return this.points.slice();
  }

  size(): number {
    return this.points.length;
  }

  last(): TimePoint | null {
    return this.points[this.points.length - 1] ?? null;
  }
}
