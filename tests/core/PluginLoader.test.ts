/**
 * PluginLoader.test.ts
 *
 * Guards the path a brand-new command takes: drop the file anywhere under
 * src/commands and the loader indexes it at boot, imports it on first use and
 * hands the same instance to every caller, even when two messages race.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { PluginLoader } from '../../src/core/PluginLoader.js';
import { lazyFixtureBuilds } from '../mocks/LazyFixtureCommand.js';

const FIXTURE = fileURLToPath(new URL('../mocks/LazyFixtureCommand.ts', import.meta.url));

interface LoaderInternals {
  commandFiles: Map<string, string>;
}

describe('PluginLoader', () => {
  it('imports a deferred command once, even for concurrent lookups', async () => {
    const loader = PluginLoader.getInstance();
    const buildsBefore = lazyFixtureBuilds.count;
    (loader as unknown as LoaderInternals).commandFiles.set('lazyfixture', FIXTURE);

    const [first, second] = await Promise.all([
      loader.getCommand('lazyfixture'),
      loader.getCommand('lazyfixture'),
    ]);

    expect(first?.name).toBe('lazyfixture');
    expect(second).toBe(first);
    expect(lazyFixtureBuilds.count - buildsBefore).toBe(1);
    expect(loader.hasCommand('lazyfixture')).toBe(true);
  });

  it('returns null for a name nobody exports instead of throwing', async () => {
    const loader = PluginLoader.getInstance();
    await expect(loader.getCommand('comandoquenoexisteni123')).resolves.toBeNull();
  });
});
