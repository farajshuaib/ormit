# Migration-first with Ormit

A minimal, runnable example of the workflow Ormit is built around: **you write
models, the CLI diffs them against the last committed snapshot and generates the
migration — you never hand-write DDL or introspect a live database** (ADR-006).

```
src/models.ts   entity classes + defineModel(m) — the single source of truth
src/db.ts       the DbContext used by the app at runtime
src/cli.ts      wires @ormit/cli + @ormit/migrations + @ormit/sqlite into runnable commands
src/seed.ts     inserts through the tracked DbContext and queries it back, to prove the schema works
migrations/     generated migration files — commit these
model.snapshot.json   the committed model snapshot the differ compares against — commit this
data/           the SQLite database file — gitignored, rebuilt by db:update
```

## Run it

```bash
pnpm install                 # from the repo root, once

cd examples/migration-first
pnpm migrations:add init     # diff src/models.ts against an empty baseline
pnpm db:update                # apply pending migrations to data/app.db
pnpm seed                     # insert a user + post, then query them back with an include
```

You should see:

```
created migrations/<timestamp>_init.ts
updated .../model.snapshot.json
applied: [ '<timestamp>_init' ]
Faraj <faraj@example.com>
  - Hello, Ormit
```

## Evolve the schema

This is the part that makes it "migration-first": change the model, regenerate,
re-apply — no manual `ALTER TABLE`, no diffing the live database.

1. Add a field to `User` in `src/models.ts`, e.g. `bio!: string | null;`, and
   configure it: `e.property((x) => x.bio).isRequired(false);`
2. `pnpm migrations:add "add user bio"` — diffs your change against the
   **committed** `model.snapshot.json` (not the live DB) and writes a new
   migration with an automatic `down`.
3. `pnpm db:update` — applies just the new migration; already-applied ones are
   skipped (idempotent, safe to run on every deploy).
4. Commit the new file under `migrations/` and the updated `model.snapshot.json`
   together — they're the unit of change.

Check what happened at any point:

```bash
pnpm migrations:list   # applied vs. pending, by id
pnpm db:script         # print the forward DDL for every registered migration
pnpm migrations:repair # re-derive model.snapshot.json if a git merge conflicted it
pnpm db:down 1         # revert the last migration
pnpm reset             # wipe data/, migrations/, and the snapshot — start over
```

## Why this shape

- **The model, not the database, is the source of truth.** `cli.ts` builds a
  fresh `ModelSnapshot` from `defineModel()` on every run and diffs it against
  whatever `model.snapshot.json` says was last committed — it never inspects
  `data/app.db`'s actual schema.
- **Migrations are plain, hand-mergeable TypeScript** (see any file under
  `migrations/`) — data, not a DSL, so two branches' migrations rarely conflict,
  and if they do, `pnpm migrations:repair` resolves the snapshot deterministically
  from the model.
- **`src/cli.ts` is a ~90-line stand-in for the `ormit` binary** — in a real
  project you'd likely use `@ormit/cli` behind an actual CLI wrapper, but the
  underlying calls (`createCli`, `.add`, `.list`, `.update`, `.revert`, `.script`,
  `.repair`) are exactly what a generated binary would call.
- **Swap `@ormit/sqlite` for `@ormit/postgres`/`mysql`/`mssql`** and everything
  else — models, migrations, `saveChanges()` — is unchanged; only the engine
  construction (`src/cli.ts`/`src/db.ts`) and DB connection info differ. See
  [docs/guide.md](../../docs/guide.md#choosing-a-database).
