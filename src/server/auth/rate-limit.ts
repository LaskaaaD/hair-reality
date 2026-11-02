export type AuthLimits = {
  accountFailures: number;
  ipAttempts: number;
  windowMs: number;
};

export class AttemptWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tooMany(key: string, now: number): boolean {
    return this.current(key, now).length >= this.limit;
  }

  add(key: string, now: number): void {
    const next = this.current(key, now);
    next.push(now);
    this.hits.set(key, next);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private current(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    this.hits.set(key, kept);
    return kept;
  }
}
