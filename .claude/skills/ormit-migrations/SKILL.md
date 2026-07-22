---
name: ormit-migrations
description: Snapshot-diff migrations in @ormit/migrations and the @ormit/cli facade + real ormit binary — the model differ (ModelSnapshot vs ModelSnapshot, never the live DB), TS migration emitter, Migrator runner with history table, snapshot repair/conflict resolution, the CLI command surface (add/list/remove/update/repair/script/has-pending-changes), the ormit.config.ts convention, and the esbuild-based ts-loader. Use when changing migration generation, the history/runner mechanics, CLI commands, or the config/migration-loading machinery in bin.ts.
---

# Ormit migrations & CLI (ADR-006)

Core principle: migrations come from **diffing two committed model snapshots**,
never introspecting a live database. `docs/adr/006-model-differ-migrations.md` has
the rationale.

## Differ — [migrations/differ.ts](packages/migrations/src/differ.ts)

`diffSnapshots(from, to)` operates per **physical table**, not per entity —
`tableModels()` merges columns from every `EntitySnapshot` mapped to the same table
(this is how owned-one flattening and future table-sharing scenarios stay correct).
Emits, in order: `dropTable` (tables gone entirely) → per remaining table:
`createTable`+`createIndex`s (new table) or `addColumn`/`dropColumn` +
`createIndex`/`dropIndex` (diffed by name-presence, not content — renaming a column
looks like drop+add, renaming an index looks like drop+create; there's no rename
detection). `diffWithDown()` just calls `diffSnapshots` twice with arguments
swapped — the "down" migration is the structural inverse, not a data-preserving
rollback.

`EMPTY_SNAPSHOT` (`{version: 1, entities: []}`) is the implicit "before" of the
very first migration.

## Emitter — [migrations/emitter.ts](packages/migrations/src/emitter.ts)

`migrationId(name, at)` → `<14-digit-UTC-timestamp>_<slugified-name>`. Emitted
source is a plain TS module exporting `id`, `up: MigrationOperation[]`, `down:
MigrationOperation[]` as **JSON-serialized literals** (`JSON.stringify(up, null,
2)`) — the emitted file is described as "safe to edit, but keep up/down in sync"; it
is not templated into builder calls, just embedded operation data.

## Runner — [migrations/runner.ts](packages/migrations/src/runner.ts)

`Migrator` tracks applied state in a `__ormit_migrations` history table (columns:
`id`, `appliedAt`), created via `ensureHistory()` which swallows the create error if
the table already exists (no existence check — relies on the DB rejecting a
duplicate `CREATE TABLE`). `up()` is **idempotent**: filters to migrations not yet
in `applied()`, sorted by id (which sorts chronologically since ids are timestamp-
prefixed), and runs each migration's `up` ops inside one `transaction()` per
migration (so a partial failure only rolls back that migration, not the whole
batch). `down(count)` takes the last `count` applied ids (by history order, reversed)
and requires each to still be present in the registered `migrations` array — throws
a plain `Error` (not an `OrmitError`) if a historical id isn't registered anymore.

Requires `engine.generator.compileDdl` — throws a plain `Error` if the engine
doesn't implement it (not every `ISqlGenerator` must).

## Repair — [migrations/repair.ts](packages/migrations/src/repair.ts)

Addresses a specific pain point: `.snapshot.json` merge conflicts in git. Since the
model (code) is the source of truth and the snapshot is meant to be byte-canonical,
`repairSnapshot(model, committed?)` just **re-derives** the canonical form from the
current model and reports `changed: committed !== canonical` — it never tries to
merge, only regenerate + diff. `stripConflictMarkers()` best-effort strips
`<<<<<<<`/`=======`/`>>>>>>>` lines (keeping the "ours" side) before attempting to
parse the committed text, so a pure formatting/order difference (not a real
conflict) doesn't get falsely flagged as drift.

## CLI facade — [cli/index.ts](packages/cli/src/index.ts)

`createCli(ctx: CliContext)` — `ctx` bundles `engine, model, committedSnapshot?,
migrations` so the facade is **unit-testable without touching a filesystem/process**
(confirmed by its own test suite, `cli/test/cli.test.ts`, which never writes a
file). All filesystem I/O — writing migration files, the snapshot, deleting a
removed migration — happens in `bin.ts`, not here. Commands:

- `add(name)` — diffs `committedSnapshot` (or `EMPTY_SNAPSHOT`) against
  `ctx.model.data`; throws a plain `Error` if there's nothing to migrate
  (`up.length === 0`). Returns the emitted migration **and** the new snapshot text
  to commit alongside it, plus `destructive: up.some(isDestructive)` (true if any op
  is `dropTable`/`dropColumn` — see `core/src/migrations/operations.ts`) so callers
  can prompt before applying.
- `list()` — applied vs. pending ids (pending = registered minus applied).
- `update()`/`revert(count)` — thin wraps over `Migrator.up()`/`.down()`.
- `repair()` — wraps `repairSnapshot`.
- `script()` — concatenates the forward DDL SQL for **every registered migration's
  `up`** (not just pending) into one printable script, prefixed per-migration with
  a `-- <id>` comment.
- `remove()` — **no target-id parameter, always the most recent migration** (sorted
  by id). Refuses (throws) if that migration is already in `Migrator.applied()`.
  Returns `{ id, snapshot: ctx.model.toJSON() }` — the snapshot is **re-derived from
  whatever the current model says**, not reconstructed from history (there is no
  per-migration snapshot history to replay — only one cumulative
  `model.snapshot.json` ever exists). This means `remove()` is only correct if the
  caller already reverted the model change the migration captured; if they didn't,
  the failure mode is inert (the next `add()` reports "no model changes"), not
  corruption. Mirrors `dotnet ef migrations remove`'s own restriction to the latest
  migration.
- `hasPendingChanges()` — `diffSnapshots(from, ctx.model.data).length > 0`, reusing
  the `from` snapshot already computed once in `createCli()`'s closure. Powers
  `ormit migrations has-pending-changes` (a CI-friendly check with a non-zero exit
  code when there's drift).

## The real binary — [cli/bin.ts](packages/cli/src/bin.ts)

The published `ormit` command (`package.json`'s `bin` field). Resolves an
`ormit.config.{ts,mts,js,mjs}` (via [load-config.ts](packages/cli/src/load-config.ts),
searched in `process.cwd()` unless `--config <path>` is given), builds a
`ModelSnapshot` from the config's `model(m)`, loads every file in
`migrationsDir` via [load-migrations.ts](packages/cli/src/load-migrations.ts),
opens the engine via the config's `engine()` factory, and dispatches one of 7
hand-parsed verb combinations onto `createCli()` — no argv-parsing dependency.
`engine.close()` is duck-typed (`OrmEngine` itself has no `close()`; it's
dialect-specific — sync for SQLite, async pool-drain for Postgres/MySQL/MSSQL).

**[ts-loader.ts](packages/cli/src/ts-loader.ts)** is what lets `.ts` config and
migration files load with zero `tsx`/`ts-node` setup: `.ts`/`.mts` files are
transpiled with `esbuild` (bundled for the config, since it may import local
model/engine code; single-file-transformed for migrations, since their only
import — `import type { MigrationOperation }` — is fully erased) and the
transpiled output is written to a **temp file colocated in the same directory
as the source file**, then dynamically `import()`-ed and deleted in a `finally`.
This colocation is load-bearing, not incidental — two things break otherwise:
bare-specifier resolution (`import { SqliteEngine } from '@ormit/sqlite'` inside
the bundled output resolves by Node walking up `node_modules` from the
*importing file's own path* — a file written to `os.tmpdir()` or some other
shared location outside the project would never find them), and any
`import.meta.url`-based path logic inside the user's own config (the standard
`dirname(fileURLToPath(import.meta.url))` idiom only reports the *running*
file's location — relocating it anywhere other than right next to the original
silently breaks that, even if the new location still happens to be inside the
project tree). Both failure modes were caught empirically while building this
(see `packages/cli/test/loaders.test.ts`'s fixtures) before being caught by any
type checker.
