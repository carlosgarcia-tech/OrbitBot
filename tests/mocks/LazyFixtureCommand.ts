/**
 * LazyFixtureCommand.ts
 *
 * Stand-in for a command file that only gets imported on first use. Counts
 * instantiations so tests/core/PluginLoader.test.ts can assert that two
 * concurrent lookups share a single module load.
 */

export const lazyFixtureBuilds = { count: 0 };

export class LazyFixtureCommand {
  name = 'lazyfixture';
  description = 'fixture for the lazy loader';
  category = 'utility';

  constructor() {
    lazyFixtureBuilds.count++;
  }

  async execute(): Promise<void> {
    /* no-op */
  }
}
