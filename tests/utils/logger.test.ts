/**
 * logger.test.ts
 *
 * The buffered logger forwards its arguments straight to pino, which only
 * reads fields from the FIRST argument. `logger.error('msg', { detail })` was
 * silently dropping `detail` in production, so errors looked empty. These
 * tests pin the merge and the Error flattening.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('pino', () => {
  const record = (...args: unknown[]) => {
    calls.push(args);
  };
  const instance = { info: record, warn: record, error: record, debug: record };
  const pino = Object.assign(
    vi.fn(() => instance),
    {
      stdTimeFunctions: { isoTime: () => '' },
    },
  );
  return { default: pino };
});

import { logger } from '@/utils/logger.js';

describe('logger', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('keeps the meta fields next to the message', async () => {
    logger.error('[VerCommand] fallo', { kind: 'video', source: 'quote' });
    await logger.flush();

    expect(calls[0][0]).toMatchObject({
      msg: '[VerCommand] fallo',
      kind: 'video',
      source: 'quote',
    });
  });

  it('flattens an Error passed as the second argument', async () => {
    logger.error('[X] error', new Error('boom'));
    await logger.flush();

    expect(calls[0][0]).toMatchObject({
      msg: '[X] error',
      error: { name: 'Error', message: 'boom' },
    });
  });
});
