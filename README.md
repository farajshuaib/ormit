# Ormit — EF Core–style ORM for TypeScript

> `DbContext`, `DbSet`, typed LINQ-like queries, change tracking, and migrations —
> for Node.js, on any SQL database. Kysely under the hood, never in your face.

**Status: 1.0-rc candidate — Phases 0–9 implemented; all four dialects (SQLite,
Postgres, MySQL, SQL Server) pass the behavioral compatibility suite against real
servers via Testcontainers.** See `docs/implementation-plan.md` for the full roadmap.

```ts
class AppDb extends DbContext {
  users = this.set(User);
  protected onModelCreating(m: ModelBuilder) {
    m.entity(User, e => e.toTable('users').hasKey('id'));
  }
}

const adults = await db.users
  .where(x => x.age.gt(18).and(x.name.startsWith('A')))
  .orderBy(x => x.name)
  .take(10)
  .toList();

db.users.add(new User({ name: 'Nour', age: 28 }));
await db.saveChanges();
```

## Packages

| Package | Purpose |
|---|---|
| `@ormit/core` | IR, expression recorder, Queryable + pipeline (normalizer/optimizer/cache), DbContext/DbSet, change tracking (identity map + UoW), metadata (ModelBuilder + conventions + ModelSnapshot), engine contracts. Zero deps. |
| `@ormit/engine-kysely` | Lowers IR onto Kysely; SQL compilation for all four dialects (PG, SQLite, MySQL, MSSQL). |
| `@ormit/sqlite` | SQLite dialect: Kysely `sqlite` generator + a better-sqlite3 executor (real execution). |
| `@ormit/postgres` | PostgreSQL dialect: Kysely `postgres` generator + a node-postgres executor (RETURNING, connection-affine transactions). |
| `@ormit/mysql` | MySQL dialect: Kysely `mysql` generator + a mysql2 executor (`insertId` key write-back; implicit DDL commit). |
| `@ormit/mssql` | SQL Server dialect: Kysely `mssql` generator + a node-mssql executor (OUTPUT INSERTED.*, TOP / OFFSET…FETCH). |
| `@ormit/plugins` | First-party plugins (soft-delete, timestamps, multitenancy) — built only on the public plugin surface. |
| `@ormit/migrations` | Model differ (snapshot vs snapshot), TS migration emitter, runner with history, snapshot repair. |
| `@ormit/cli` | Command facade behind the `ormit` binary (migrations add/list, database update, script, repair). |
| `@ormit/decorators` | `@entity/@key/@column/@hasOne/@hasMany` decorators that replay into the ModelBuilder. |
| `@ormit/adapters` | Thin per-request DI/lifecycle glue for Express, Fastify, and NestJS (frameworks typed structurally — zero framework deps). |
| `@ormit/testing` | In-memory engine with real query semantics — unit tests need no database. |

## Development

```bash
pnpm install
pnpm build          # tsc -b, project references
pnpm test           # vitest (195 offline tests; PG/MySQL/MSSQL suites skip without Docker)
pnpm test:types     # tsd-style compile-time rejection of illegal operators
pnpm test:coverage  # + conventions branch-coverage gate (100%)
pnpm perf:compile   # compile-time perf gate (50-entity model typechecks < 3s)
pnpm test:containers # PG + MySQL + MSSQL compatibility suites on real servers (needs Docker)
pnpm gate           # build + deps + type tests + coverage
pnpm gate:rc        # gate + compile-perf (release-candidate gate)
```

## What's implemented (M1)

- Typed Proxy **expression recorder** (ADR-001): `x.age.gt(18)`, string ops (`startsWith`,
  `contains`, `like`, `toLower/toUpper`), null checks, `in`, `between`, logical composition,
  nested paths, column-to-column comparison, and to-many navigation operators
  (`posts.any(…)`, `.all(…)`, `.count()` → EXISTS / correlated subquery).
  Untranslatable expressions throw `TranslationError` at build time — never silent.
- **Expression pipeline (Phase 3):** metadata-aware **normalizer** (query-filter injection,
  owned/override column resolution) and **optimizer** (constant folding, logical
  simplification, double-negation elimination, conjunct splitting). Gate-verified:
  capture survives **esbuild + terser** minification, illegal operators are rejected by
  compile-time type tests, and `irHash` is **stable across processes** (golden file).
- **Query pipeline (Phase 4):** `Queryable` runs `IR → normalize → optimize → generate`
  with a bounded **LRU** memoizing compiled commands. Full surface — `where`, `orderBy`,
  `skip/take`, `distinct`, `select()` projections, `asNoTracking`, `ignoreQueryFilters`,
  and terminals `toList/first/single/count/any/sum/avg/min/max/toPage` — plus `fromSql`
  parameterized tagged templates. **Real SQLite execution** via `@ormit/sqlite`
  (better-sqlite3): insert + RETURNING key write-back, aggregates, projections. Gate:
  SQL-snapshot suite (PG + SQLite), a **fast-check property round-trip** proving compiled
  SQLite matches the reference interpreter, and a recorded materializer baseline.
- **Change tracking & UoW (Phase 5):** snapshot-diffing **identity map** over POCO
  entities (ADR-005) with the `Detached/Added/Unchanged/Modified/Deleted` state machine.
  `add/attach/remove/find/entry`; `find` and query results dedupe through the identity
  map. `saveChanges` **detects changes → topo-sorts** the FK graph (insert parent→child,
  delete child→parent) → runs **atomically** → writes generated keys back → refreshes
  snapshots. **Optimistic concurrency** tokens raise `ConcurrencyError`; `database.transaction`
  gives ambient transactions (AsyncLocalStorage); `createContextFactory` pools isolated,
  `Symbol.asyncDispose`-resettable contexts. Verified end-to-end on real SQLite.
- **Relationships & loading (Phase 6):** `include`/`thenInclude` eager loading via
  **split queries** (ADR-003), filtered includes, explicit loading
  (`entry().reference/collection().load()`), and opt-in `LazyRef`/`LazyCollection`
  (ADR-004). **Cascade delete** / `setNull` on principal removal. An **N+1 detector**
  (diagnostics mode) flags repeated single-entity loads (`OMT2001`). A blog example
  runs end-to-end on SQLite.
- **Cross-cutting & plugins (Phase 7):** an `OrmPlugin` surface — `configureModel`,
  `normalizerPasses`, and lifecycle `interceptors` (`savingChanges`/`savedChanges`,
  `commandExecuting`/`commandExecuted`). First-party **`@ormit/plugins`** ships
  **soft-delete** (remove→update rewrite + global filter, built only on the public
  surface — the dogfood proof), **timestamps**, and **multitenancy** (ALS-driven tenant
  filter pass + insert stamping). All three compose.
- **Migrations & CLI (Phase 8):** a **model differ** compares the current `ModelSnapshot`
  to the committed one (never the live DB, ADR-006) → `MigrationOperation[]` with
  auto-down; a **TS emitter** writes timestamped migration files; `compileDdl` lowers ops
  to per-dialect DDL. The **runner** applies/reverts through an `__ormit_migrations`
  history table — `up()` is idempotent. **Repair** re-derives the canonical snapshot from
  a git-conflicted one. The `@ormit/cli` facade backs `migrations add/list`,
  `database update`, `script`, and `repair`. Verified forward-and-back on SQLite.
- **IR structural hashing** (compiled-query/cache key), golden-tested.
- **Kysely engine** compiling deterministic, parameterized SQL for Postgres and SQLite.
- **Metadata (Phase 2):** full `ModelBuilder` — `property/hasKey` (incl. composite),
  relationships (`hasOne/hasMany` 1:1/1:N/N:M), owned types (`ownsOne` flattened,
  `ownsMany`), value converters, indexes, seed data, query filters, TPH discriminators.
  A **conventions engine** (pluralization, key/FK discovery — 100% branch coverage)
  fills gaps under `convention < decorator < fluent` precedence. Produces an immutable,
  eagerly-validated `ModelSnapshot` that **serializes byte-identically** (sorted keys,
  merge-friendly) for the migrations differ. 25 curated invalid models each raise a
  documented `OMT12xx` diagnostic (see [`docs/diagnostics.md`](docs/diagnostics.md)).
- Error codes (`OMT1xxx`), strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

- **Hardening & 1.0-rc (Phase 9):** SQL generation for **all four dialects** (PG, SQLite,
  MySQL, MSSQL — placeholder/paging/quoting deltas snapshot-tested); a **decorators**
  package that replays into the ModelBuilder (`convention < decorator < fluent`); a
  **SQL-injection fuzz** pass proving `fromSql` interpolations are always bound
  parameters; a **compile-time perf gate** (50-entity model typechecks in ~0.25s, budget
  3s); MIT `LICENSE`, `SECURITY.md`, and a [guide](docs/guide.md) with a "Coming from
  EF Core" table.

- **Real-database dialects (all four):** `@ormit/postgres` (node-postgres),
  `@ormit/mysql` (mysql2), and `@ormit/mssql` (node-mssql) each run the behavioral
  compatibility suite — CRUD, global query filters, aggregates, paging, optimistic
  concurrency, transaction rollback — against **real servers via Testcontainers**
  (`pnpm test:containers`; gated behind `ORMIT_TESTCONTAINERS` so the default gate stays
  offline). Verified green on `postgres:16`, `mysql:8`, and `mssql/server:2022`. Each
  exercises its dialect's key-return path (RETURNING / `insertId` / `OUTPUT INSERTED.*`)
  and paging (`LIMIT/OFFSET` vs `TOP` / `OFFSET…FETCH`).
- **Framework adapters:** `@ormit/adapters` provides per-request context lifecycle glue —
  Express middleware, a Fastify plugin, and NestJS providers (REQUEST-scoped) — typed
  structurally so no framework is a dependency; each creates a pooled context per request
  and disposes it when the response ends.
- **CI, benchmarks & release:** GitHub Actions runs the offline gate on every push and,
  nightly, the four-dialect Testcontainers matrix plus a **throughput regression gate**
  (`pnpm bench`: Ormit's rows/sec *ratio vs the raw better-sqlite3 driver*, ±10% band —
  machine-independent). A Changesets workflow publishes under `@ormit` with **npm
  provenance**. Packages ship `dist` only (verified via `npm pack --dry-run`).

## Remaining for 1.0 (per plan)

Cross-ORM benchmark *publication* (vs Prisma/TypeORM/Drizzle/MikroORM on a dedicated
runner — the ±10% gate and raw-driver overhead harness exist today), and the two external
pilot sign-offs on the rc checklist.
