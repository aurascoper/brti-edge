import type { PrimarySeries, TimePoint } from "@polyterminal/types";
import { RingBuffer } from "../state/ringBuffer";

export class SeriesStore {
  midpointYes: RingBuffer;
  btcReference: RingBuffer;
  spreadYes: RingBuffer;
  equity: RingBuffer;

  constructor(capacity = 3_600) {
    this.midpointYes = new RingBuffer(capacity);
    this.btcReference = new RingBuffer(capacity);
    this.spreadYes = new RingBuffer(capacity);
    this.equity = new RingBuffer(capacity);
  }

  append(now: number, mid: number | null, spread: number | null, btc: number | null): void {
    if (mid !== null) this.midpointYes.append(now, mid);
    if (spread !== null) this.spreadYes.append(now, spread);
    if (btc !== null) this.btcReference.append(now, btc);
    if (mid !== null) this.equity.append(now, mid);
  }

  seedMidpoint(points: TimePoint[]): void {
    this.midpointYes.seed(points);
    this.equity.seed(points);
  }

  seedBtc(points: TimePoint[]): void {
    this.btcReference.seed(points);
  }

  primary(): PrimarySeries {
    return {
      midpointYes: this.midpointYes.snapshot(),
      btcReference: this.btcReference.snapshot(),
      spreadYes: this.spreadYes.snapshot(),
    };
  }

  equitySnapshot(): TimePoint[] {
    return this.equity.snapshot();
  }
}
