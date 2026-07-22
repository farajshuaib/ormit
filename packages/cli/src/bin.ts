#!/usr/bin/env node
/**
 * `ormit` — the CLI binary. Resolves an `ormit.config.{ts,mts,js,mjs}` from
 * the current directory (or `--config <path>`), loads the migrations
 * directory it points at, and dispatches the given command onto the pure
 * `Cli` facade (see index.ts) — this file is the only place that touches the
 * filesystem or opens a real engine connection.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelBuilder, ModelSnapshot, type OrmEngine } from '@ormit/core';
import { createCli } from './index.js';
import { loadConfig } from './load-config.js';
import { loadMigrations } from './load-migrations.js';

const USAGE = `Usage: ormit <command> [options]

  migrations add <name>              diff the model and emit a migration + snapshot
  migrations list                    applied vs. pending migrations
  migrations remove                  delete the most recent (unapplied) migration
  migrations repair                  re-derive the snapshot after a merge conflict
  migrations has-pending-changes     exit 1 if the model has unmigrated changes
  database update                    apply all pending migrations
  database update --down [n]         revert the last n migrations (default 1)
  script                             print the forward DDL for every migration

Options:
  --config <path>   path to an ormit config file (default: ormit.config.{ts,js,mjs} in cwd)
  -h, --help        show this message
`;

/** `OrmEngine` has no `close()` — it's dialect-specific (sync for SQLite,
 * async pool-drain for Postgres/MySQL/MSSQL) — so duck-type it. */
async function closeEngine(engine: OrmEngine): Promise<void> {
  const close = (engine as unknown as { close?: () => unknown }).close;
  if (typeof close === 'function') await close.call(engine);
}

interface ParsedArgs {
  readonly rest: readonly string[];
  readonly config?: string;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const rest: string[] = [];
  let config: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--config') config = argv[++i];
    else if (arg === '-h' || arg === '--help') help = true;
    else rest.push(arg);
  }
  return { rest, help, ...(config !== undefined ? { config } : {}) };
}

async function main(): Promise<void> {
  const { rest, config: configPath, help } = parseArgs(process.argv.slice(2));
  if (help || rest.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = help ? 0 : 1;
    return;
  }

  const { config, root } = await loadConfig(configPath);
  const migrationsDir = resolve(root, config.migrationsDir ?? './migrations');
  const snapshotPath = resolve(root, config.snapshotPath ?? './model.snapshot.json');

  const builder = new ModelBuilder();
  config.model(builder);
  const model = ModelSnapshot.build(builder);

  const committedSnapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : undefined;
  const { migrations, filenameOf } = await loadMigrations(migrationsDir);

  const engine = await config.engine();
  try {
    const cli = createCli({
      engine,
      model,
      migrations,
      ...(committedSnapshot !== undefined ? { committedSnapshot } : {}),
    });

    const [group, cmd, ...args] = rest;

    if (group === 'migrations' && cmd === 'add') {
      const name = args.join(' ');
      if (!name) throw new Error('Usage: ormit migrations add <name>');
      const { migration, snapshot, destructive } = cli.add(name);
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(resolve(migrationsDir, migration.filename), migration.source);
      writeFileSync(snapshotPath, snapshot);
      console.log(`Created ${migration.filename}`);
      if (destructive) console.warn('warning: this migration drops a table or column.');
    } else if (group === 'migrations' && cmd === 'list') {
      const { applied, pending } = await cli.list();
      console.log('Applied:', applied.length ? applied.join(', ') : '(none)');
      console.log('Pending:', pending.length ? pending.join(', ') : '(none)');
    } else if (group === 'migrations' && cmd === 'remove') {
      const { id, snapshot } = await cli.remove();
      const file = filenameOf(id);
      if (file) unlinkSync(file);
      writeFileSync(snapshotPath, snapshot);
      console.log(`Removed ${id}.`);
      console.log(
        'If you have not already reverted the model change it captured, do that now — ' +
          'the rewritten snapshot reflects whatever your model currently describes.',
      );
    } else if (group === 'migrations' && cmd === 'repair') {
      const { snapshot, changed } = cli.repair();
      writeFileSync(snapshotPath, snapshot);
      console.log(changed ? 'Snapshot repaired (drift found and corrected).' : 'Snapshot already canonical.');
    } else if (group === 'migrations' && cmd === 'has-pending-changes') {
      const pending = cli.hasPendingChanges();
      console.log(pending ? 'Pending model changes: yes' : 'Pending model changes: no');
      process.exitCode = pending ? 1 : 0;
    } else if (group === 'database' && cmd === 'update') {
      if (args[0] === '--down') {
        const count = Number(args[1] ?? '1');
        console.log('Reverted:', await cli.revert(count));
      } else {
        console.log('Applied:', await cli.update());
      }
    } else if (group === 'script') {
      console.log(cli.script());
    } else {
      process.stdout.write(USAGE);
      process.exitCode = 1;
    }
  } finally {
    await closeEngine(engine);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
