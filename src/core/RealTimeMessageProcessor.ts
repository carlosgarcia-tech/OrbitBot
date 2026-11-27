/**
 * RealTimeMessageProcessor.ts
 *
 * Concurrency controller for inbound message handling.
 *
 * Three queues are kept because inbound traffic has three distinct concurrency
 * requirements:
 *
 * - **Sequential** (default): commands that mutate shared state (economy,
 *   levels, moderation) run strictly one at a time, in FIFO arrival order.
 * - **Parallel** (`parallelizable`): read-only lookups and light I/O run with a
 *   small fixed cap so a burst cannot saturate the event loop or trip
 *   WhatsApp's rate limits.
 * - **Heavy** (`heavy`): downloads and ffmpeg get a smaller cap of their own,
 *   so two long jobs cannot occupy every parallel slot and starve `!ping`.
 *
 * It also acts as a deduplicator: a message ID already queued or running is
 * rejected outright, so a reconnect that re-delivers the same message cannot
 * execute its command twice.
 *
 * Emits: `processed` (id) after each success, `error` (id, error) on failure.
 * Listeners are attached in WhatsAppClient to update statistics.
 *
 * @author **Carlos G**
 * @github carlosgarcia-tech
 * @tiktok carlos.grcia0
 * @instagram carlos.gxv
 * @created 2026-03-16
 */

import { EventEmitter } from 'events';

/** Concurrency class of a message. */
export type MessageLane = 'sequential' | 'parallel' | 'heavy';

/** Read-only work: 5 keeps a burst from saturating a small VPS/Termux. */
const PARALLEL_MAX = 5;
/** Downloads and ffmpeg: two at a time is the most a basic VPS handles well. */
const HEAVY_MAX = 2;

/** One unit of work waiting to run. */
interface QueuedMessage {
  id: string;
  handler: () => Promise<void>;
}

/** Capped FIFO lane shared by the parallel and heavy classes. */
interface CappedLane {
  queue: QueuedMessage[];
  active: number;
  max: number;
}

export class RealTimeMessageProcessor extends EventEmitter {
  /** IDs currently executing, used by the stats snapshot. */
  private processing = new Set<string>();
  /** IDs queued or executing, used to reject duplicate submissions. */
  private pending = new Set<string>();
  private sequentialQueue: QueuedMessage[] = [];
  private readonly parallelLane: CappedLane = { queue: [], active: 0, max: PARALLEL_MAX };
  private readonly heavyLane: CappedLane = { queue: [], active: 0, max: HEAVY_MAX };
  /** Guard flag preventing a second sequential drain loop from starting. */
  private isProcessingSequential = false;

  /**
   * Enqueues a message handler on the queue matching its concurrency class.
   *
   * @param messageId Dedup key; a second submission while queued or running is ignored.
   * @param handler Work to run once a slot is available.
   * @param lane Concurrency class; defaults to the strict sequential lane.
   * @returns False when the message ID is already pending, true otherwise.
   */
  async process(
    messageId: string,
    handler: () => Promise<void>,
    lane: MessageLane = 'sequential',
  ): Promise<boolean> {
    if (this.pending.has(messageId)) return false;
    this.pending.add(messageId);

    if (lane === 'sequential') {
      this.sequentialQueue.push({ id: messageId, handler });
      setImmediate(() => void this.processSequentialQueue());
    } else {
      const target = lane === 'heavy' ? this.heavyLane : this.parallelLane;
      target.queue.push({ id: messageId, handler });
      setImmediate(() => void this.drainLane(target));
    }
    return true;
  }

  /**
   * Runs one queued item and reports its outcome through the emitter.
   *
   * Never rejects on a handler failure: the error is emitted instead, so the
   * lane that owns the item can keep draining.
   */
  private async runItem(item: QueuedMessage): Promise<void> {
    this.processing.add(item.id);
    try {
      await item.handler();
      this.emit('processed', item.id);
    } catch (error) {
      this.emit('error', item.id, error);
    } finally {
      this.processing.delete(item.id);
      this.pending.delete(item.id);
    }
  }

  /**
   * Drains one capped lane, one item per call.
   *
   * The reschedule at the end runs only after the slot is released, so the cap
   * can never be exceeded even when several items finish at once.
   */
  private async drainLane(lane: CappedLane): Promise<void> {
    if (lane.active >= lane.max || lane.queue.length === 0) return;
    const item = lane.queue.shift();
    if (!item) return;

    lane.active++;
    try {
      await this.runItem(item);
    } finally {
      lane.active--;
      if (lane.queue.length > 0) {
        setImmediate(() => void this.drainLane(lane));
      }
    }
  }

  /**
   * Drains the sequential queue in strict FIFO order, one item at a time.
   *
   * The `isProcessingSequential` guard makes re-entrancy harmless: if a second
   * drain is requested while one is awaiting a handler, it returns immediately
   * and the in-flight loop will pick up any newly queued items itself.
   */
  private async processSequentialQueue(): Promise<void> {
    if (this.isProcessingSequential) return;
    if (this.sequentialQueue.length === 0) return;
    this.isProcessingSequential = true;
    try {
      while (this.sequentialQueue.length > 0) {
        const item = this.sequentialQueue.shift();
        if (!item) break;
        await this.runItem(item);
      }
    } finally {
      this.isProcessingSequential = false;
    }
  }

  /** Queue snapshot used by the client's periodic maintenance log and the panel. */
  getStats() {
    return {
      processing: this.processing.size,
      sequentialQueued: this.sequentialQueue.length,
      parallelQueued: this.parallelLane.queue.length,
      heavyQueued: this.heavyLane.queue.length,
      activeParallel: this.parallelLane.active,
      activeHeavy: this.heavyLane.active,
      pending: this.pending.size,
    };
  }
}
