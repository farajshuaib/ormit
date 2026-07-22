# Migration-first with Ormit

A minimal, runnable example of the workflow Ormit is built around: **you write
models, the `ormit` CLI diffs them against the last committed snapshot and
generates the migration — you never hand-write DDL or introspect a live
database** (ADR-006), the same way `dotnet ef migrations add`/`database update`
work against an EF Core `DbContext`.

```
ormit.config.ts       tells the ormit binary how to build the engine + model
src/models.ts         entity classes + defineModel(m) — the single source of truth
src/db.ts             the DbContext used by the app at runtime
src/seed.ts           inserts through the tracked DbContext and queries it back, to prove the schema works
migrations/            generated migration files — commit these
model.snapshot.json    the committed model snapshot the differ compares against — commit this
data/                  the SQLite database file — gitignored, rebuilt by db:update
```

## Run it

```bash
pnpm install                 # from the repo root, once — links the `ormit` binary

cd examples/migration-first
pnpm migrations:add init     # ormit migrations add init — diffs models.ts against an empty baseline
pnpm db:update                # ormit database update — apply pending migrations to data/app.db
pnpm seed                     # insert a user + post, then query them back with an include
```

You should see:

```
Created <timestamp>_init.ts
updated .../model.snapshot.json
Applied: [ '<timestamp>_init' ]
Faraj <faraj@example.com>
  - Hello, Ormit
```

Every `pnpm migrations:*`/`db:*` script is a one-line call to the real `ormit`
binary (`node_modules/.bin/ormit`, linked automatically since this package
depends on `@ormit/cli`) — see `package.json`. There is no hand-written wiring
script; `ormit.config.ts` is the only glue, and it's ~15 lines.

## Evolve the schema

This is the part that makes it "migration-first": change the model, regenerate,
re-apply — no manual `ALTER TABLE`, no diffing the live database.

1. Add a field to `User` in `src/models.ts`, e.g. `bio!: string | null;`, and
   configure it: `e.property((x) => x.bio).isRequired(false);`
2. `pnpm migrations:has-pending-changes` — confirms Ormit sees the drift (exits
   non-zero; useful as a CI check to catch a forgotten migration).
3. `pnpm migrations:add "add user bio"` — diffs your change against the
   **committed** `model.snapshot.json` (not the live DB) and writes a new
   migration with an automatic `down`.
4. `pnpm db:update` — applies just the new migration; already-applied ones are
   skipped (idempotent, safe to run on every deploy).
5. Commit the new file under `migrations/` and the updated `model.snapshot.json`
   together — they're the unit of change.

Check what happened at any point:

```bash
pnpm migrations:list                # applied vs. pending, by id
pnpm migrations:has-pending-changes  # exits non-zero if the model drifted without a migration
pnpm db:script                      # print the forward DDL for every registered migration
pnpm migrations:repair              # re-derive model.snapshot.json if a git merge conflicted it
pnpm migrations:remove              # delete the most recent migration — only if it's not yet applied
pnpm db:down 1                      # revert the last migration
pnpm reset                          # wipe data/, migrations/, and the snapshot — start over
```

`migrations:remove` mirrors `dotnet ef migrations remove`'s own restriction: it
always targets the most recent migration and refuses if it's already applied
(revert it first with `db:down`). Run it *after* reverting the model change it
captured — Ormit re-derives `model.snapshot.json` from whatever the model
currently says, it doesn't reconstruct history.

## Why this shape

- **The model, not the database, is the source of truth.** `ormit` builds a
  fresh `ModelSnapshot` from `defineModel()` on every run and diffs it against
  whatever `model.snapshot.json` says was last committed — it never inspects
  `data/app.db`'s actual schema.
- **Migrations are plain, hand-mergeable TypeScript** (see any file under
  `migrations/`) — data, not a DSL, so two branches' migrations rarely conflict,
  and if they do, `pnpm migrations:repair` resolves the snapshot deterministically
  from the model.
- **`ormit.config.ts` is the only glue**, using `defineConfig` from `@ormit/cli`.
  It's transpiled on the fly (via a bundled `esbuild`) — no `tsx`/`ts-node`
  registration needed to run `ormit` itself; `tsx` here is only used for
  `pnpm seed`, an ordinary app script.
- **Swap `@ormit/sqlite` for `@ormit/postgres`/`mysql`/`mssql`** and everything
  else — models, migrations, `saveChanges()` — is unchanged; only the engine
  construction in `ormit.config.ts`/`src/db.ts` and the DB connection info
  differ. See [docs/guide.md](../../docs/guide.md#choosing-a-database).
