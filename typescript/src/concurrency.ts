// Scheduling primitives: bounded concurrency, request pacing and cost budgets.

/** Run at most `limit` callbacks at once; waiters resume in FIFO order. */
export class Semaphore {
  private busy = 0;
  private waiters: Array<() => void> = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed directly to the next waiter, so `busy` only
    // drops when nobody is queued.
    if (this.busy >= this.limit)
      await new Promise<void>((r) => this.waiters.push(r));
    else this.busy++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.busy--;
    }
  }
}

/** Space request starts evenly at `rpm` requests per minute. */
export class RateLimiter {
  private readonly interval: number;
  private next = 0;
  constructor(rpm: number) {
    if (!Number.isFinite(rpm) || rpm <= 0)
      throw Error("requests per minute must be positive and finite");
    this.interval = 60000 / rpm;
  }
  async wait() {
    const now = performance.now(),
      start = Math.max(now, this.next);
    this.next = start + this.interval;
    await new Promise((r) => setTimeout(r, start - now));
  }
}

/** Spending limit that also stops once any cost is unknown. */
export class Budget {
  readonly limit: number | null;
  spent = 0;
  unknown = 0;
  constructor(limit: number | null) {
    this.limit = limit;
  }
  add(cost: number | null) {
    if (cost === null) this.unknown++;
    else this.spent += cost;
  }
  exhausted() {
    return (
      this.limit !== null && (this.spent >= this.limit || this.unknown > 0)
    );
  }
}

/** Process `items` with `workers` concurrent loops pulling from one iterator. */
export async function jobs<T>(
  items: Iterable<T>,
  workers: number,
  fn: (item: T) => Promise<void>,
) {
  const it = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let next = it.next(); !next.done; next = it.next())
        await fn(next.value);
    }),
  );
}
