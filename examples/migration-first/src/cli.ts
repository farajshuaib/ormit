/**
 * The migration-first workflow, end to end:
 *
 *   1. Describe your schema in models.ts (plain classes + defineModel()).
 *   2. `pnpm migrations:add <name>` — diffs the model against the last
 *      *committed* model.snapshot.json (or an empty baseline for the very
 *      first migration) and writes a migration file + the new snapshot.
 *   3. Commit the migration file and the updated snapshot.
 *   4. `pnpm db:update` — applies every pending migration to the SQLite file
 *      in data/app.db, idempotently (safe to run on every deploy).
 *
 * This file is the thin, hand-rollable equivalent of the `ormit` binary
 * described in the docs — it exists so the workflow is runnable with zero
 * extra tooling, using only `@ormit/cli` + `@ormit/migrations` + `@ormit/sqlite`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModelBuilder, ModelSnapshot } from '@ormit/core';
import { createCli, type CliContext } from '@ormit/cli';
import type { Migration } from '@ormit/migrations';
import { SqliteEngine } from '@ormit/sqlite';
import { defineModel } from './models.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(root, 'migrations');
const snapshotPath = join(root, 'model.snapshot.json');
const dbPath = join(root, 'data', 'app.db');

/** Load every migration module already emitted, in id (chronological) order. */
async function loadMigrations(): Promise<Migration[]> {
  if (!existsSync(migrationsDir)) return [];
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(migrationsDir, file)).href)) as Migration;
    migrations.push({ id: mod.id, up: mod.up, down: mod.down });
  }
  return migrations;
}

function usage(): never {
  console.log(`Usage:
  tsx src/cli.ts migrations add <name>
  tsx src/cli.ts migrations list
  tsx src/cli.ts migrations repair
  tsx src/cli.ts database update
  tsx src/cli.ts database update --down [count]
  tsx src/cli.ts script`);
  process.exit(1);
}

async function main(): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const engine = new SqliteEngine(dbPath);

  // The same defineModel() the DbContext uses — the migration tooling never
  // touches the live database's schema, only this in-memory model.
  const builder = new ModelBuilder();
  defineModel(builder);
  const model = ModelSnapshot.build(builder);

  const committedSnapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : undefined;
  const migrations = await loadMigrations();

  const ctx: CliContext = {
    engine,
    model,
    migrations,
    ...(committedSnapshot !== undefined ? { committedSnapshot } : {}),
  };
  const cli = createCli(ctx);

  const [group, cmd, ...rest] = process.argv.slice(2);

  try {
    if (group === 'migrations' && cmd === 'add') {
      const name = rest.join(' ');
      if (!name) usage();
      const { migration, snapshot, destructive } = cli.add(name);
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, migration.filename), migration.source);
      writeFileSync(snapshotPath, snapshot);
      console.log(`created migrations/${migration.filename}`);
      console.log(`updated ${snapshotPath}`);
      if (destructive) console.warn('warning: this migration drops a table or column');
    } else if (group === 'migrations' && cmd === 'list') {
      const { applied, pending } = await cli.list();
      console.log('applied:', applied.length ? applied : '(none)');
      console.log('pending:', pending.length ? pending : '(none)');
    } else if (group === 'migrations' && cmd === 'repair') {
      const { snapshot, changed } = cli.repair();
      writeFileSync(snapshotPath, snapshot);
      console.log(changed ? 'snapshot repaired (drift found and corrected)' : 'snapshot already canonical');
    } else if (group === 'database' && cmd === 'update') {
      if (rest[0] === '--down') {
        const count = Number(rest[1] ?? '1');
        console.log('reverted:', await cli.revert(count));
      } else {
        console.log('applied:', await cli.update());
      }
    } else if (group === 'script') {
      console.log(cli.script());
    } else {
      usage();
    }
  } finally {
    engine.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
