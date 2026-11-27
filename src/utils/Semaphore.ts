/**
 * Semaphore.ts
 *
 * Bounds how many asynchronous tasks run at once and queues the rest FIFO.
 *
 * Used for work that must not starve cheap commands: AI mention replies now,
 * and heavy downloads in the next phase. A slot is handed directly to the
 * next waiter, so `active` never exceeds `max`.
 *
 * @author **Carlos G**
 * @created 2026-11-26
 */

/** FIFO concurrency limiter. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param max Maximum tasks running at the same time.
   * @throws When `max` is not a positive integer.
   */
  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('Semaphore max must be a positive integer');
    }
  }

  /**
   * Runs `task` as soon as a slot is free.
   *
   * @param task Work to run; its result or error is propagated.
   * @returns The task's result.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Current number of running tasks; useful for metrics and tests. */
  get running(): number {
    return this.active;
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot over without decrementing: it is already counted.
      next();
      return;
    }
    this.active--;
  }
}
