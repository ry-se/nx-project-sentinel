const UINT32_RANGE = 4_294_967_296;

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = normalizeSeed(seed);
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new Error('Simulation seed must be a finite number.');
  }

  return Math.trunc(seed) >>> 0;
}
