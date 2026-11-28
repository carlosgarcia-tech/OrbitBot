/**
 * DownloadService.test.ts
 *
 * Pins the process budget and the log cap: at most two external processes run
 * at once (a third waits), stdout is returned whole because metadata calls
 * parse it as JSON, and a noisy stderr keeps only its tail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { DownloadService } from '@/services/download/DownloadService.js';

vi.mock('child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFile: vi.fn() }));

const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

/** Exposes the protected runner without changing its behaviour. */
class TestDownloadService extends DownloadService {
  run(timeout?: number): Promise<string> {
    return this.runCommand('yt-dlp', ['--version'], timeout);
  }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Child process stand-in with controllable stdout, stderr and exit. */
function fakeChild() {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();

  const add = (key: string, cb: (...args: never[]) => void): void => {
    const list = listeners.get(key) ?? [];
    list.push(cb);
    listeners.set(key, list);
  };
  const emit = (key: string, ...args: unknown[]): void => {
    for (const cb of listeners.get(key) ?? []) {
      (cb as (...values: unknown[]) => void)(...args);
    }
  };

  return {
    stdout: {
      on: (_event: string, cb: (chunk: Buffer) => void) =>
        add('stdout', cb as (...args: never[]) => void),
    },
    stderr: {
      on: (_event: string, cb: (chunk: Buffer) => void) =>
        add('stderr', cb as (...args: never[]) => void),
    },
    on: (event: string, cb: (code: number) => void) => add(event, cb as (...args: never[]) => void),
    kill: vi.fn(),
    emitStdout(text: string): void {
      emit('stdout', Buffer.from(text));
    },
    emitStderr(text: string): void {
      emit('stderr', Buffer.from(text));
    },
    finish(code = 0): void {
      emit('close', code);
    },
  };
}

describe('DownloadService.runCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs at most two external processes at once and queues the third', async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let spawned = 0;
    mockedSpawn.mockImplementation(() => children[spawned++]);

    const service = new TestDownloadService();
    const runs = [service.run(), service.run(), service.run()];

    await flush();
    expect(mockedSpawn).toHaveBeenCalledTimes(2);

    children[0].finish(0);
    await flush();
    expect(mockedSpawn).toHaveBeenCalledTimes(3);

    children[1].finish(0);
    children[2].finish(0);
    await expect(Promise.all(runs)).resolves.toEqual(['', '', '']);
  });

  it('returns stdout whole so metadata can be parsed as JSON', async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);

    const run = new TestDownloadService().run();
    await flush();
    child.emitStdout('{"title":"a song"}');
    child.finish(0);

    await expect(run).resolves.toBe('{"title":"a song"}');
  });

  it('keeps only the tail of stderr, where the real error is', async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);

    const run = new TestDownloadService().run();
    await flush();
    child.emitStderr('x'.repeat(20_000) + 'FINAL ERROR');
    child.finish(1);

    const error = await run.catch((reason: Error) => reason);
    expect(error.message).toContain('FINAL ERROR');
    expect(error.message.length).toBeLessThanOrEqual(8 * 1024);
  });
});
