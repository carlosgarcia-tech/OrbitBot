/**
 * Semaphore.test.ts
 *
 * FIFO concurrency limit: never more than `max` tasks running, waiters start
 * in order as slots free up, and an error still releases its slot.
 */

import { describe, it, expect } from 'vitest';
import { Semaphore } from '@/utils/Semaphore.js';

/** Promise whose resolution the test controls. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('Semaphore', () => {
  it('caps concurrent tasks and runs waiters in FIFO order', async () => {
    const semaphore = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const tasks = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);
    expect(semaphore.running).toBe(2);

    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(tasks);
    expect(semaphore.running).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const semaphore = new Semaphore(1);
    const success = deferred();

    await expect(semaphore.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    const task = semaphore.run(async () => {
      success.resolve();
    });
    await success.promise;
    await task;
    expect(semaphore.running).toBe(0);
  });

  it('rejects an invalid maximum', () => {
    expect(() => new Semaphore(0)).toThrow('positive integer');
    expect(() => new Semaphore(1.5)).toThrow('positive integer');
  });
});
