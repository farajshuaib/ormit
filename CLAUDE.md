# CLAUDE.md — working in the Ormit codebase

Technical reference for Claude (and engineers) working in this repo. Ormit is an
EF Core–style ORM for TypeScript: `DbContext`/`DbSet`, typed LINQ-like queries,
snapshot change tracking, and snapshot-diff migrations, over any SQL database,
with Kysely as the SQL engine (never exposed in the public API).

The authoritative design doc is [`docs/implementation-plan.md`](docs/implementation-plan.md);
architecture decisions are in [`docs/adr/`](docs/adr). This file is the fast path.

## Ground rules

- **Do not `git commit` or push.** The maintainer reviews and commits. Leave the
  tree in a reviewable state and report what changed.
- **Strict TypeScript everywhere.** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (base tsconfig). Match the
  surrounding style; keep comments at the existing density (why, not what).
- **The only `any` boundary is `@ormit/engine-kysely`** — it drives Kysely
  dynamically from IR. Nothing `any` leaks into public types.
- **Dependency rules are enforced** (`scripts/check-deps.mjs`): `core` imports
  nothing from the workspace and nothing from `kysely`; only `engine-kysely`
  imports `kysely`; dialect packages import `engine-kysely`, never `kysely`.

## Commands

```bash
pnpm build           # tsc -b across all packages (project references)
pnpm test            # vitest — runs against TS source (see aliases below)
pnpm test:coverage   # + conventions.ts must stay 100% branch (enforced threshold)
pnpm test:types      # tsd-style compile gate: illegal operators must not typecheck
pnpm check:deps      # dependency-rule gate
pnpm perf:compile    # 50-entity model must typecheck < 3s
pnpm gate            # build + check:deps + test:types + test:coverage
pnpm gate:rc         # gate + perf:compile   (offline release-candidate gate)
pnpm test:containers # PG/MySQL/MSSQL compatibility suites — needs Docker
pnpm bench           # throughput ratio vs raw better-sqlite3 (BENCH_GATE=1 to enforce ±10%)
```

**Gotcha:** committed/stale `*.tsbuildinfo` can make `tsc -b` think it's
up-to-date and skip emitting `dist/`. If a build "succeeds" but `dist/` is
missing or tests can't resolve a package, run
`find packages -name '*.tsbuildinfo' -delete` and rebuild.

## Package map

```
packages/
  core/            @ormit/core         IR, recorder, Queryable + pipeline, DbContext/DbSet,
                                        change tracking, metadata, engine contracts. Zero deps.
  engine-kysely/   @ormit/engine-kysely IR → Kysely OperationNode; per-dialect SQL + DDL. The `any` seam.
  dialect-sqlite/  @ormit/sqlite       better-sqlite3 executor
  dialect-postgres/@ormit/postgres     node-postgres executor
  dialect-mysql/   @ormit/mysql        mysql2 executor (insertId key write-back)
  dialect-mssql/   @ormit/mssql        node-mssql executor (OUTPUT INSERTED.*)
  plugins/         @ormit/plugins      soft-delete / timestamps / multitenancy (public-surface only)
  migrations/      @ormit/migrations   differ, TS emitter, runner + history, repair
  cli/             @ormit/cli          command facade (add/list/update/script/repair)
  decorators/      @ormit/decorators   @entity/@key/@column/@hasOne/@hasMany → ModelBuilder
  adapters/        @ormit/adapters     Express/Fastify/NestJS per-request lifecycle glue
  testing/         @ormit/testing      InMemoryEngine (real query semantics, no DB)
```

`examples/*` is a separate, non-publishable workspace root (`pnpm-workspace.yaml`) for
runnable demo apps — e.g. `examples/migration-first` — kept out of `packages/` so
`scripts/check-deps.mjs` and the `pnpm build` package list never need to know about them.

## Architecture: the two seams

Everything hinges on two interfaces in `core/src/contracts/engine.ts`:

- **`ISqlGenerator`** — `compileSelect/compileWrite/compileRaw/compileDdl`. Turns
  IR into `{ sql, params, irHash }`. Implemented by `engine-kysely`.
- **`IQueryExecutor`** — `query/execute/transaction?` + `capabilities`
  (`DialectCapabilities`). Implemented per dialect package.

`core` only ever knows these two. Swapping engine or dialect is transparent.

## Read path (query pipeline)

`Queryable` is immutable; each method forks the `SelectExpr` IR.

```
lambda → recorder (Proxy IR) → SelectExpr
       → normalize   (inject query filters, resolve owned/override columns, plugin passes)
       → optimize    (constant fold, logical simplify, ¬¬ elim)
       → ISqlGenerator.compileSelect → { sql, params, irHash }
       → LRU (irHash → CompiledCommand)
       → IQueryExecutor.query
       → materialize (column→property; identity-map register unless asNoTracking)
       → loadIncludes (split queries for Include/ThenInclude)
```

- Recorder: `core/src/expressions/recorder.ts`. A typed Proxy records property
  access + operators into a closed IR (ADR-001) — **no `fn.toString()`,
  minification-safe**. `where`/`orderBy`/`select`/`include` selectors run once at
  build time.
- Pipeline: `core/src/pipeline/{normalizer,optimizer,prepare,cache}.ts`.
  `prepareSelect` composes normalize+optimize+passes and is shared by `Queryable`
  and the include loader.

## Write path (change tracking & UoW, ADR-005)

`core/src/tracking/`:
- `tracker.ts` — identity map keyed by entity type + serialized key; scalar
  snapshot diffing; `Detached/Added/Unchanged/Modified/Deleted` state machine.
- `save.ts` — `planSave` turns tracker state into ordered write ops:
  topo-sorted over the FK graph (insert parent→child, delete child→parent),
  change-only update columns, key + concurrency-token predicates, cascade.

`DbContext.saveChanges` (`core/src/context/db-context.ts`): detect → plugin
`savingChanges` → plan → execute atomically (`executor.transaction`, ambient via
`AsyncLocalStorage`) → key write-back → `acceptChanges` → `savedChanges`. Zero
affected rows on a tracked update/delete ⇒ `ConcurrencyError`.

## Metadata (ADR-006 feeds migrations)

`core/src/metadata/`:
- `builder.ts` — fluent `ModelBuilder`/`EntityBuilder` record raw intent.
  `configure()` lets plugins extend a declared entity without a duplicate error.
- `conventions.ts` — **pure functions; must stay 100% branch coverage.**
  Pluralization, key/FK discovery, type inference.
- `finalize.ts` — raw + conventions → immutable snapshot; collects all
  validation diagnostics in one pass. Precedence `convention < decorator < fluent`.
- `serialize.ts` — `stableStringify` (recursively sorted keys) makes
  `ModelSnapshot` **byte-identical across a round-trip** — the migration differ
  depends on this.
- `diagnostics.ts` — `OMT12xx` model-validation codes, mirrored in
  [`docs/diagnostics.md`](docs/diagnostics.md).

## Key invariants (don't break these)

- **No runtime reflection.** Property CLR types default to `'unknown'` unless
  set via `hasType()` or inferable (`hasMaxLength` ⇒ string). FKs use EF-style
  shadow synthesis when not configured. This is why some tests set `.hasType('number')`.
- **`irHash` is a stable structural hash** (FNV-1a over canonical JSON) — the
  cache key and compiled-query key. Golden-tested (`core/test/hash.test.ts`);
  changing canonicalization breaks the golden on purpose.
- **Snapshot round-trips byte-identical** (`core/test/model.test.ts` +
  `fixtures/rich-model.snapshot.json`).
- **Conventions at 100% branch** (vitest `thresholds.branches: 100`).
- **Errors carry stable codes** (`OMT1xxx` query, `OMT12xx` model). Public error
  types: `TranslationError`, `EntityNotFoundError`, `ConcurrencyError`,
  `ModelValidationError`.

## Per-dialect quirks (in `engine-kysely`)

Insert key-return and paging differ; the generator branches on dialect:
- **Returning:** PG/SQLite `RETURNING *`; MSSQL `OUTPUT INSERTED.*`; MySQL none
  (executor reads `insertId`).
- **Paging:** PG/MySQL/SQLite `LIMIT/OFFSET`; MSSQL `TOP` (take-only) or
  `OFFSET…FETCH` (requires `ORDER BY`, auto-added). SQL Server has **no `LIMIT`**.

## Testing conventions

- `vitest.config.ts` aliases every `@ormit/*` to its **`src`** — tests run
  against TypeScript source (accurate coverage, no stale-dist hazard).
- Container suites (`packages/dialect-{postgres,mysql,mssql}/test/*.compat.test.ts`)
  are `describe.runIf(process.env.ORMIT_TESTCONTAINERS)` — skipped by default so
  the offline gate needs no Docker.
- Type tests: `packages/core/test-d/` with `@ts-expect-error`, run by
  `pnpm test:types`.
- When adding a package: add it to the root `build` script, the `vitest.config.ts`
  aliases, and (if publishable) give it `license`/`files: ["dist"]`/`repository`.
