/**
 * RealTimeMessageProcessor.test.ts
 *
 * Concurrency controller: strict FIFO for the sequential lane, fixed caps for
 * the parallel and heavy lanes, and dedupe while a message is queued or
 * running.
 */

import { describe, it, expect } from 'vitest';
import { RealTimeMessageProcessor } from '@/core/RealTimeMessageProcessor.js';

/** Promise whose resolution the test controls. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Lets pending promise chains and scheduled immediates drain.
 *
 * Freeing a slot runs through `finally` and then a `setImmediate` that starts
 * the next item, so a single turn is not always enough.
 */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** Starts `count` gated tasks and returns the ids in start order. */
function startGated(
  processor: RealTimeMessageProcessor,
  count: number,
  lane: 'sequential' | 'parallel' | 'heavy',
  started: string[],
): Array<ReturnType<typeof deferred>> {
  return Array.from({ length: count }, (_, index) => {
    const gate = deferred();
    const id = `${lane}-${index}`;
    void processor.process(
      id,
      async () => {
        started.push(id);
        await gate.promise;
      },
      lane,
    );
    return gate;
  });
}

describe('RealTimeMessageProcessor', () => {
  it('runs the sequential lane one at a time in FIFO order', async () => {
    const processor = new RealTimeMessageProcessor();
    const started: string[] = [];
    const gates = startGated(processor, 2, 'sequential', started);

    await flush();
    expect(started).toEqual(['sequential-0']);

    gates[0].resolve();
    await flush();
    expect(started).toEqual(['sequential-0', 'sequential-1']);

    gates[1].resolve();
    await flush();
    expect(processor.getStats().sequentialQueued).toBe(0);
  });

  it('caps the parallel lane at five tasks', async () => {
    const processor = new RealTimeMessageProcessor();
    const started: string[] = [];
    const gates = startGated(processor, 6, 'parallel', started);

    await flush();
    expect(started).toHaveLength(5);
    expect(processor.getStats().activeParallel).toBe(5);
    expect(processor.getStats().parallelQueued).toBe(1);

    gates[0].resolve();
    await flush();
    expect(started).toHaveLength(6);

    gates.slice(1).forEach(gate => gate.resolve());
    await flush();
    expect(processor.getStats().activeParallel).toBe(0);
  });

  it('caps the heavy lane at two tasks', async () => {
    const processor = new RealTimeMessageProcessor();
    const started: string[] = [];
    const gates = startGated(processor, 3, 'heavy', started);

    await flush();
    expect(started).toEqual(['heavy-0', 'heavy-1']);
    expect(processor.getStats().heavyQueued).toBe(1);

    gates[0].resolve();
    await flush();
    expect(started).toContain('heavy-2');

    gates.slice(1).forEach(gate => gate.resolve());
    await flush();
    expect(processor.getStats().activeHeavy).toBe(0);
  });

  it('rejects a duplicate message id while it is queued or running', async () => {
    const processor = new RealTimeMessageProcessor();
    const gate = deferred();
    const started: string[] = [];

    const first = await processor.process('same-id', async () => {
      started.push('first');
      await gate.promise;
    });
    const duplicate = await processor.process('same-id', async () => {
      started.push('second');
    });

    expect(first).toBe(true);
    expect(duplicate).toBe(false);

    gate.resolve();
    await flush();
    expect(started).toEqual(['first']);

    // After completion the id is free to be submitted again.
    const again = await processor.process('same-id', async () => {
      started.push('third');
    });
    expect(again).toBe(true);
    await flush();
    expect(started).toEqual(['first', 'third']);
  });

  it('reports queued and running work in its stats snapshot', async () => {
    const processor = new RealTimeMessageProcessor();
    const gate = deferred();

    void processor.process(
      'stats-1',
      async () => {
        await gate.promise;
      },
      'parallel',
    );

    await flush();
    expect(processor.getStats()).toMatchObject({
      processing: 1,
      parallelQueued: 0,
      activeParallel: 1,
      pending: 1,
    });

    gate.resolve();
    await flush();
    expect(processor.getStats()).toMatchObject({ processing: 0, pending: 0 });
  });
});
