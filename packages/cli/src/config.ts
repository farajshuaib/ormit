/**
 * `ormit.config.ts` shape — the project-root config the `ormit` binary loads
 * to find the engine, model, and migrations directory, so commands can be run
 * directly (`ormit migrations add <name>`) with no hand-written wiring script.
 */
import type { ModelBuilder, OrmEngine } from '@ormit/core';

export interface OrmitConfig {
  /** Constructs (or connects) the engine. A factory, not a live instance, so
   * loading the config for `--help`/`migrations list` doesn't need to open a
   * real connection until a command actually runs. */
  engine(): OrmEngine | Promise<OrmEngine>;
  /** The same model definition the app's DbContext uses in onModelCreating. */
  model(m: ModelBuilder): void;
  /** Directory of emitted migration files. Default: './migrations'. */
  migrationsDir?: string;
  /** Path to the committed model snapshot. Default: './model.snapshot.json'. */
  snapshotPath?: string;
}

/** Identity helper for editor type-checking/inference — mirrors the
 * `defineConfig` convention of other JS config-file-driven CLIs. */
export function defineConfig(config: OrmitConfig): OrmitConfig {
  return config;
}
