# Implementation Plan — **Ormit**: EF Core–Style ORM for TypeScript

**Status:** Approved for implementation · **Version:** 1.0 · **Engine:** Kysely (ADR-002)
All decisions in this document are final unless an ADR supersedes them. Sections marked **[FROZEN]** are API contracts that require an ADR to change.

---

## 1. Decision Summary

| Area | Decision | ADR |
|---|---|---|
| Query engine | Kysely (`OperationNode` AST); consumed only via engine seam | ADR-002 |
| Expression capture | Typed Proxy recorder; no `fn.toString()` parsing, no client eval | ADR-001 |
| Collection includes | Split queries by default; `.asSingleQuery()` opt-in | ADR-003 |
| Lazy loading | Explicit `LazyRef<T>` / `LazyCollection<T>` with `await .load()`; no sync getters | ADR-004 |
| Change tracking | Snapshot diffing + Identity Map; POCO entities; optional notify mode | ADR-005 |
| Migrations | Model differ (snapshot vs snapshot), not DB introspection | ADR-006 |
| Dialects at 1.0 | PostgreSQL, MySQL, SQLite, MSSQL | — |
| Tooling | pnpm workspaces, Turborepo, Changesets, vitest, tsd, ESLint (strict), TS `strict` + `noUncheckedIndexedAccess` | — |
| Name | **Ormit** — npm scope `@ormit/*`; unscoped `ormit` reserved for the CLI. Availability verified against the registry on 2026-07-08; secure scope + name immediately in Phase 0 | — |

**Out of scope for 1.0:** NoSQL, client-side query evaluation, `engine-native` (raw drivers — post-1.0, benchmark-gated), DB-first scaffolding beyond basic CLI, GraphQL/REST generators.

---

## 2. Package Layout & Dependency Rules

```
packages/
├─ core/              @ormit/core            zero workspace deps, zero engine deps
├─ engine-kysely/     @ormit/engine-kysely   deps: core, kysely (pinned minor)
├─ dialect-postgres/  @ormit/postgres        deps: core, engine-kysely, pg
├─ dialect-mysql/     @ormit/mysql           deps: core, engine-kysely, mysql2
├─ dialect-sqlite/    @ormit/sqlite          deps: core, engine-kysely, better-sqlite3
├─ dialect-mssql/     @ormit/mssql           deps: core, engine-kysely, tedious
├─ migrations/        @ormit/migrations      deps: core
├─ cli/               @ormit/cli             deps: migrations; dialects loaded dynamically
├─ decorators/        @ormit/decorators      deps: core
├─ testing/           @ormit/testing         deps: core (in-memory engine, SQL asserts)
├─ plugin-*/          soft-delete, timestamps, multitenancy (first-party plugins)
├─ adapters/          nestjs, fastify, express (thin DI/lifecycle glue)
├─ examples/          blog, saas-multitenant    (not published)
└─ docs/              Docusaurus site           (not published)
```

**Rules (ESLint `no-restricted-imports` + `dependency-cruiser` in CI):**
1. `core` imports nothing from the workspace and nothing from Kysely.
2. Dialect packages never import `kysely` directly — only `engine-kysely`.
3. Public entry points are explicit `exports` maps; deep imports blocked.
4. Every published package: ESM + CJS dual build (tsup), `sideEffects: false`, type-checked examples in docs blocks.

---

## 3. Public API Contract **[FROZEN]**

The 1.0 consumer surface. Signatures are binding; bodies are illustrative.

```ts
// ---- Context & sets -------------------------------------------------
abstract class DbContext {
  constructor(options: DbContextOptions);
  protected set<T extends object>(entity: Ctor<T>): DbSet<T>;
  protected abstract onModelCreating(model: ModelBuilder): void;
  saveChanges(): Promise<number>;
  entry<T extends object>(entity: T): EntityEntry<T>;
  readonly database: DatabaseFacade;      // transaction(), executeSql``, migrate()
  [Symbol.asyncDispose](): Promise<void>;
}

interface DbSet<T extends object> extends Queryable<T> {
  add(entity: T): T;            addRange(entities: T[]): void;
  remove(entity: T): void;      removeRange(entities: T[]): void;
  attach(entity: T): T;
  find(...key: KeyOf<T>): Promise<T | null>;      // identity-map first
  fromSql(strings: TemplateStringsArray, ...params: unknown[]): Queryable<T>;
}

// ---- Queryable (immutable; every method returns a new Queryable) ----
interface Queryable<T extends object> {
  where(predicate: (x: EntityRef<T>) => BoolExpr): Queryable<T>;
  orderBy(sel: PathSelector<T>): OrderedQueryable<T>;
  orderByDescending(sel: PathSelector<T>): OrderedQueryable<T>;
  include<N extends NavKeys<T>>(sel: NavSelector<T, N>): IncludableQueryable<T, T[N]>;
  select<R>(proj: (x: EntityRef<T>) => ProjectionShape<R>): Queryable<Materialize<R>>;
  skip(n: number): Queryable<T>;   take(n: number): Queryable<T>;
  distinct(): Queryable<T>;
  asNoTracking(): Queryable<T>;    asSingleQuery(): Queryable<T>;
  ignoreQueryFilters(): Queryable<T>;
  // terminals
  toList(): Promise<T[]>;
  first(): Promise<T>;             firstOrNull(): Promise<T | null>;
  single(): Promise<T>;            singleOrNull(): Promise<T | null>;
  count(): Promise<number>;        any(): Promise<boolean>;
  sum(sel: NumSelector<T>): Promise<number>;   // avg/min/max same shape
  toPage(page: number, size: number): Promise<Page<T>>;
}
// IncludableQueryable adds: thenInclude(...)
// OrderedQueryable adds:    thenBy(...) / thenByDescending(...)

// ---- Expression operators available on FieldRef<TProp> --------------
// all:      eq, neq, in, isNull, isNotNull
// ordered:  gt, gte, lt, lte, between
// string:   startsWith, endsWith, contains, like, toLower, toUpper
// bool:     and, or, not (on BoolExpr)
// nav 1:N:  any(pred?), all(pred), count()          → subquery/EXISTS
// example:  x => x.age.gt(18).and(x.name.startsWith('A'))

// ---- Model configuration (fluent; decorators replay into this) ------
interface ModelBuilder {
  entity<T extends object>(ctor: Ctor<T>, build: (e: EntityBuilder<T>) => void): void;
}
// EntityBuilder: toTable, hasKey, property(sel) → PropertyBuilder
//   (hasColumnName, hasMaxLength, isRequired, hasDefault, hasConversion,
//    isConcurrencyToken, valueGenerated, hasIndex, hasComment)
// hasOne/withMany, hasMany/withOne, hasMany/withMany(usingEntity?),
// ownsOne/ownsMany, hasQueryFilter, hasData(seed[]), hasDiscriminator (TPH)

// ---- Composition -----------------------------------------------------
function createContextFactory<C extends DbContext>(
  ctor: Ctor<C>, opts: FactoryOptions): ContextFactory<C>;   // .create(), pooling
const compileQuery: <C extends DbContext, A extends unknown[], R>(
  q: (db: C, ...args: ParamsOf<A>) => Promise<R>) => (db: C, ...args: A) => Promise<R>;
```

**Error types (public, stable):** `ConcurrencyError` (carries failed entries), `TranslationError` (untranslatable expression — thrown at build time, never silent), `EntityNotFoundError`, `MigrationLockError`, `ValidationFailedError`.

---

## 4. Internal Contracts **[FROZEN within workspace]**

The seams that make the engine and dialects swappable. These live in `core`.

```ts
interface ISqlGenerator {                    // IR → engine artifact
  compileSelect(q: SelectExpr, ctx: GenContext): CompiledCommand;
  compileInsert(op: InsertOp, ctx: GenContext): CompiledCommand;
  compileUpdate(op: UpdateOp, ctx: GenContext): CompiledCommand;
  compileDelete(op: DeleteOp, ctx: GenContext): CompiledCommand;
  compileDdl(op: MigrationOperation, ctx: GenContext): CompiledCommand[];
}
interface CompiledCommand { sql: string; params: readonly unknown[]; irHash: string; }

interface IQueryExecutor {
  query(cmd: CompiledCommand, tx?: TxHandle): Promise<Row[]>;
  execute(cmd: CompiledCommand, tx?: TxHandle): Promise<{ affected: number; returning?: Row[] }>;
  begin(iso?: IsolationLevel): Promise<TxHandle>;   // commit/rollback/savepoint on handle
  capabilities: DialectCapabilities;
}
interface DialectCapabilities {
  returningStrategy: 'returning' | 'output' | 'lastInsertId' | 'secondQuery';
  ddlInTransaction: boolean;  savepoints: boolean;
  maxParams: number;          upsertSyntax: 'onConflict' | 'onDuplicateKey' | 'merge';
  ilike: boolean;             paging: 'limitOffset' | 'offsetFetch';
}

interface OrmPlugin {
  name: string;
  conventions?: Convention[];
  normalizerPasses?: NormalizerPass[];       // IR → IR
  interceptors?: Partial<Interceptors>;
  materializerHooks?: MaterializerHook[];
  cliCommands?: CliCommandDef[];
}
```

`engine-kysely` implements `ISqlGenerator` by lowering IR → `OperationNode` and letting Kysely's per-dialect compilers produce `{sql, params}`. Dialect packages supply `DialectCapabilities` + quirk overrides only.

---

## 5. Subsystem Specifications (condensed; each maps 1:1 to an epic in §6)

**S1 · Expression system.** Proxy recorder produces a closed IR: `Select / Binary / Logical / Not / IsNull / Like / In / Exists / Column / Constant / FunctionCall / Aggregate / Case / Coalesce / RawPredicate`. Nodes immutable, structurally hashed (`irHash` = cache & compiled-query key). Proxy is metadata-aware: unmapped member access throws `TranslationError` at build time.

**S2 · Metadata.** `ModelBuilder` → immutable `ModelSnapshot` (entities, composite keys, properties + converters, navigations with FK/cascade, owned types flattened with prefix, query filters stored as IR, indexes, seed data, TPH discriminators). Built once per context class, module-cached, eagerly validated. Precedence: convention < decorator < fluent. Snapshot is JSON-serializable with sorted keys (merge-friendly; consumed by migrations).

**S3 · Query pipeline.** `IR → Normalizer (inject filters, expand owned types, navs→EXISTS/joins) → Optimizer (constant folding, predicate pushdown) → ISqlGenerator → IQueryExecutor → Shaper → Materializer`. Includes: to-one = LEFT JOIN aliased columns; collections = split queries (`WHERE fk IN (…)` per level), `.asSingleQuery()` opt-in. Materializer wires both navigation directions, registers in Identity Map unless `asNoTracking`, stores snapshots. Ad-hoc LRU (1024) memoizes `irHash → {sql, materializer plan}`; `compileQuery` does the same eagerly.

**S4 · Change tracking & UoW.** States: `Detached / Added / Unchanged / Modified / Deleted` (Added + remove ⇒ Detached). Identity Map keyed by entity type + serialized key tuple. Snapshot diff in `detectChanges()`; relationship fixup keeps FKs and navs coherent (FK wins conflicts). `saveChanges()`: detect → validate → `saving` interceptors → build ops → topo-sort on FK graph (inserts parent→child, deletes child→parent) → transaction (ambient-aware) → batch per (table, op) within `maxParams` → write back generated keys/rowversions → concurrency check (`affected === 0` ⇒ collect, throw `ConcurrencyError` after batch) → commit → snapshots refresh → `saved` events. Contexts short-lived, not concurrency-safe; pooled factory resets tracker structures.

**S5 · Transactions.** `saveChanges` atomic by default. `database.transaction(fn)` = AsyncLocalStorage ambient transaction; nesting → savepoints where supported; isolation levels pass-through; pluggable `IExecutionStrategy` for transient-error retry (e.g., PG serialization failures).

**S6 · Migrations & CLI.** Differ compares current `ModelSnapshot` to committed `.snapshot.json` → `MigrationOperation[]` (+ auto down) → emitted TS migration class. Runner: advisory/migration lock → `__ormit_migrations` history table → apply pending in tx (respecting `ddlInTransaction`; MySQL DDL journaled with warning). SQLite drops/renames via table-rebuild. Seed data (`hasData`) participates in diffing. CLI verbs: `ormit migrations add|list|remove|repair`, `ormit database update|drop`, `ormit script --idempotent`, `ormit diagnose`.

**S7 · Cross-cutting.** Interceptor pipeline (`commandCreating/Executed`, `saving/savedChanges`, `transaction*`, `materialized`); typed event emitter for observability; structured logs (SQL, redactable params, duration) with pino/winston adapters + OpenTelemetry spans + slow-query threshold; validation hooks pre-save (zod/class-validator adapters); plugins per §4. First-party plugins: **soft-delete** (remove→update rewrite + global filter), **timestamps**, **multitenancy** (discriminator-column mode with `ITenantProvider` via ALS; database-per-tenant via factory + CLI orchestration).

**S8 · Loading strategies.** Eager (`include/thenInclude`, filtered includes), explicit (`entry().collection().load()` / `.reference().load()`), lazy opt-in via `LazyRef`/`LazyCollection` (ADR-004). Many-to-many: implicit synthesized join entity or explicit `usingEntity` with payload; tracker manages join rows on collection mutation.

---

## 6. Work Breakdown & Milestones

Six milestones, M0–M5. Each phase lists its epics, key tasks, and a hard exit gate (all gates are CI-enforced). Phases 2 and 3 run in parallel after Phase 1; Phase 8 can begin once S2's snapshot format freezes.

### Phase 0 — Repo bootstrap (M0)
- pnpm workspace + Turborepo + Changesets; base tsconfig (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); tsup dual-build template; ESLint + dependency-cruiser rules from §2; vitest + tsd wiring; CI matrix skeleton (lint, typecheck, unit, type-tests); ADR directory with ADR-001…006 committed.
- **Gate:** `pnpm build && pnpm test` green on empty packages; dependency rules fail the build when violated (verified by a fixture).

### Phase 1 — Core abstractions (M1)
- Epics: `DbContext`/`DbSet` shells, options plumbing, `ISqlGenerator`/`IQueryExecutor`/`DialectCapabilities`/`OrmPlugin` contracts, error types, in-memory engine in `@ormit/testing`.
- **Gate:** context instantiates against in-memory engine; contract types published; 100% type-test coverage on public signatures from §3.

### Phase 2 — Metadata (M1)
- Epics: `ModelBuilder` fluent API; conventions engine (naming, FK discovery, pluralization); composite keys; owned types; value converters; TPH; snapshot serialization; eager validation with actionable diagnostics (error codes `OMT1xxx`).
- **Gate:** snapshot round-trips byte-identical; conventions at 100% branch coverage; 25 curated invalid-model fixtures each produce the documented diagnostic.

### Phase 3 — Expression system (M1)
- Epics: proxy recorder; `FieldRef` operator algebra (typed per property type); IR node set + structural hashing; normalizer passes (filters, owned expansion, nav rewriting); optimizer (folding, pushdown).
- **Gate:** capture correct under esbuild+terser minification fixtures; illegal operators rejected by tsd tests; hash stable across processes (golden file).

### Phase 4 — Query pipeline (M2)
- Epics: `engine-kysely` lowering (IR → `OperationNode`); dialect packages (PG, SQLite first; MySQL, MSSQL second); shaper (JOIN aliasing + split queries); materializer + identity-map registration; terminals (`toList/first/single/count/any/sum…/toPage`); projections; `fromSql` tagged templates; LRU cache + `compileQuery`.
- **Gate:** SQL snapshot suite green for PG+SQLite (MySQL/MSSQL by end of phase); property-based IR→SQL round-trip on SQLite; materializer benchmark baseline recorded.

### Phase 5 — Change tracking & UoW (M2)
- Epics: identity map; snapshots + `detectChanges`; state machine; relationship fixup; `saveChanges` pipeline incl. topo-sort, batching within `maxParams`, key write-back per `returningStrategy`, concurrency tokens; ambient transactions + savepoints; execution strategies; pooled context factory with `Symbol.asyncDispose`.
- **Gate:** behavioral CRUD suite (the **compatibility suite v1**) green on all four dialects via Testcontainers; concurrency conflict tests deterministic; no cross-context instance leakage under stress test.

### Phase 6 — Relationships & loading (M3)
- Epics: 1:1, 1:N, N:M (implicit + explicit join entity); Include/ThenInclude incl. filtered includes; explicit loading; lazy `LazyRef`/`LazyCollection`; cascade behaviors.
- **Gate:** blog example app runs end-to-end on all dialects; N+1 detector in diagnostics mode flags the seeded anti-pattern fixture.

### Phase 7 — Cross-cutting & plugins (M3)
- Epics: interceptors, events, logging/OTel, validation pipeline, plugin registration; first-party plugins (soft-delete, timestamps, multitenancy discriminator mode).
- **Gate:** plugin API semver-frozen; soft-delete implemented *only* through public plugin surface (dogfood proof); multitenancy example green.

### Phase 8 — Migrations & CLI (M4)
- Epics: model differ; operation set + auto-down; TS migration emitter; runner with locking + history; idempotent script generation; `repair`; seeding; SQLite rebuild strategy; per-dialect DDL capability handling; CLI UX (`--dry-run`, destructive-change prompts).
- **Gate:** example app schema migrates forward and back on all dialects; snapshot merge-conflict fixture resolved via `repair`; idempotent script applies twice cleanly.

### Phase 9 — Hardening & 1.0-rc (M5)
- Epics: MSSQL polish; decorators package; NestJS/Fastify adapters; database-per-tenant mode; benchmark publication (vs raw Kysely, Prisma, MikroORM, TypeORM, Drizzle) with CI regression gate ±10%; compile-time perf gate (50-entity model typechecks < 3 s); docs complete (§8); security review (SQL injection fuzzing on `fromSql` and identifier paths); npm publish dry-run under `@ormit` with provenance.
- **Gate:** rc checklist (Appendix B) fully checked; two external pilot projects sign off.

---

## 7. Testing & CI Plan

| Layer | Tooling | Runs on |
|---|---|---|
| Unit (expressions, metadata, tracker) | vitest + in-memory engine | every PR |
| Type tests (API surface, illegal usage, inference) | tsd / `expectTypeOf` | every PR |
| SQL snapshot (per dialect, no DB) | vitest golden files | every PR |
| Compatibility suite (behavioral, all dialects) | Testcontainers: PG 14/16, MySQL 8, MSSQL 2022; SQLite in-proc | merge queue + nightly |
| Property-based IR round-trip | fast-check → SQLite | nightly |
| Migration up/down + schema assert | information_schema introspection | merge queue |
| Benchmarks (build time, rows/sec, save throughput) | dedicated runner, ±10% gate | nightly + release |
| Minification robustness | esbuild+terser fixture apps | every PR |

Rule: **a dialect or engine package "supports" Ormit iff it passes the compatibility suite unmodified.** The suite is the certification artifact.

---

## 8. Documentation Deliverables (ship with M5)

Quickstart per dialect (10 min) · Guides (modeling, querying, saving, relationships, migrations, transactions, testing, performance) · **"Coming from EF Core"** side-by-side table (primary adoption funnel) · TypeDoc API reference · Architecture guide + ADR index · Provider-author & plugin-author guides · Runnable examples. Docs site versioned from 1.0-rc.

---

## 9. Risk Register

| # | Risk | Mitigation | Owner gate |
|---|---|---|---|
| R1 | Proxy expressions feel "almost EF" | Operator ergonomics investment; EF migration guide; object-DSL sugar | Phase 3 DX review |
| R2 | Kysely `OperationNode` is semi-internal | Pin minors; SQL snapshot suite as upgrade tripwire | every dependency bump |
| R3 | Kysely maintenance stalls | Engine seam; `engine-native` fallback (ADR-002) | annual review |
| R4 | Type complexity slows user `tsc` | compile-time perf gate in CI (Phase 9) | M5 |
| R5 | Snapshot merge conflicts in teams | mergeable format; `repair` command; docs | Phase 8 |
| R6 | Cartesian explosion via `.asSingleQuery()` misuse | split default; N+1/row-explosion diagnostics warnings | Phase 6 |
| R7 | Batch limits (`maxParams`) differ per dialect | capability-driven chunking; fuzz test at limits | Phase 5 |

---

## Appendix A — ADR Index

- **ADR-001** Expression capture via typed Proxy recorder (accepted).
- **ADR-002** Kysely over Knex as query engine; `engine-native` reserved post-1.0, benchmark-gated (accepted; full text retained from prior revision).
- **ADR-003** Split queries default for collection includes (accepted).
- **ADR-004** Lazy loading via explicit `LazyRef`/`LazyCollection`; no sync getters (accepted).
- **ADR-005** Snapshot change tracking default; POCO entities; opt-in notify mode (accepted).
- **ADR-006** Model-differ migrations with committed JSON snapshot (accepted).

## Appendix B — 1.0-rc Release Checklist

☐ Compatibility suite green ×4 dialects ☐ Benchmarks published ☐ Type-test suite green ☐ Compile-perf gate green ☐ SQL-injection fuzz pass ☐ Docs complete incl. EF migration guide ☐ Plugin/provider guides published ☐ Changesets configured, provenance publishing enabled ☐ npm scope `@ormit` + unscoped `ormit` secured (fallbacks: `@entura`, `@relior`) ☐ LICENSE (MIT), CoC, SECURITY.md ☐ Two external pilots signed off

## Appendix C — Naming Decision

**Ormit** — selected 2026-07-08. Rationale: self-describing (ORM + kit), excellent CLI ergonomics (`ormit migrations add`, `ormit database update`), unscoped name and `@ormit/*` scope both unpublished at time of verification, no known project or trademark collision. Rejected: **Tessella** (unscoped name occupied by a dormant Mapbox tile server; trademark exposure via Tessella Ltd), **Fluentity/Kontext/Mappa/Contextly** (taken). Fallbacks if scope registration fails: **Entura**, **Relior** (both verified free). Full 15-name rationale retained in the architecture document.
