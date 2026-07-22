/**
 * Loads every migration file in a directory (sorted by filename, which sorts
 * chronologically since emitted ids are timestamp-prefixed) into `Migration[]`
 * for the `Migrator`/`Cli` facade, and tracks id -> file path for
 * `migrations remove`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Migration } from '@ormit/migrations';
import { loadTsModule } from './ts-loader.js';

const MIGRATION_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

export interface LoadedMigrations {
  readonly migrations: readonly Migration[];
  /** The migration file's absolute path for a given migration id. */
  filenameOf(id: string): string | undefined;
}

export async function loadMigrations(migrationsDir: string): Promise<LoadedMigrations> {
  const byId = new Map<string, string>();
  if (!existsSync(migrationsDir)) {
    return { migrations: [], filenameOf: (id) => byId.get(id) };
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => MIGRATION_EXTENSIONS.has(extname(f)))
    .sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const path = join(migrationsDir, file);
    const mod = await loadTsModule<Migration>(path);
    migrations.push({ id: mod.id, up: mod.up, down: mod.down });
    byId.set(mod.id, path);
  }
  return { migrations, filenameOf: (id) => byId.get(id) };
}
