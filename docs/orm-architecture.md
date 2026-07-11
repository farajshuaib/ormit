# Architecture & Implementation Plan
## An Entity Framework Core–Inspired ORM for Node.js, Built on a Pluggable SQL Engine (Kysely)

**Status:** Draft for review · **Audience:** Core contributors · **Author role:** Principal architect

---

## 1. Executive Summary

This document specifies the architecture for a production-grade, database-agnostic TypeScript ORM that delivers the Entity Framework Core developer experience on Node.js, using **Kysely as the internal SQL engine** (see ADR-002, Appendix A — Knex was the original candidate and was rejected). The engine is an implementation detail — never exposed to consumers — and sits behind an `IQueryExecutor`/`ISqlGenerator` seam so a raw-driver engine can replace it post-1.0 without public API change.

The library is organized around five pillars:

1. **A metadata model** (the "EDM equivalent") describing entities, keys, columns, relationships, owned types, and query filters — built via a Fluent API and/or decorators, compiled once into an immutable `ModelSnapshot`.
2. **A type-safe queryable pipeline** that captures query intent as an internal **expression tree**, then lowers it to the engine's SQL AST per dialect.
3. **A change tracker** implementing Identity Map + snapshot diffing + entity state machines.
4. **A unit of work** (`saveChanges()`) that topologically orders operations across a dependency graph and executes them in a transaction.
5. **A provider/plugin architecture** so dialects, conventions, interceptors, and cross-cutting features (multi-tenancy, soft delete) compose cleanly.

### The One Hard Problem (called out up front)

C# has compiler-materialized expression trees (`Expression<Func<T,bool>>`). TypeScript does not: an arrow function `x => x.age > 18` compiles to opaque JS. **We cannot parse lambdas from source at runtime reliably** (function `.toString()` parsing is brittle, breaks under minification, and defeats type checking).

**Decision:** we capture expressions with a **typed proxy** ("expression recorder"). The lambda receives a `Proxy` that records property access and a small operator algebra records comparisons. The lambda *looks* like EF (`x => x.age.gt(18)` or, with the proxy-comparison variant, `x => op(x.age, '>', 18)`), and we additionally support a fully EF-identical *string-free* form via helper operators. Details in §6. This decision drives the entire query subsystem and is the most consequential trade-off in the project.

### Non-Goals (v1)

- No query translation of arbitrary JS (no `Function.prototype.toString` parsing).
- No client-side query evaluation fallback (EF Core removed it for good reason — silent perf cliffs).
- No NoSQL providers; SQL dialects only (PostgreSQL, MySQL, SQLite, MSSQL at 1.0; the engine's `Dialect` interface admits others such as CockroachDB, LibSQL, or PlanetScale later).
- No runtime schema inference from the database (scaffolding is a CLI feature, Phase 9).

---

## 2. Goals & Guiding Principles

| Principle | Consequence |
|---|---|
| **DX parity with EF Core** | `DbContext`, `DbSet`, `include/where/orderBy/take/toList`, `saveChanges`, migrations CLI |
| **Engine fully encapsulated** | Consumers never import Kysely; providers adapt dialect quirks; engine is swappable |
| **Type safety end-to-end** | No `any` in public API; includes, filters, projections all statically checked |
| **Pay-for-what-you-use** | Lazy loading, caching, interceptors are opt-in; core stays lean |
| **Deterministic SQL** | Same query object ⇒ same SQL string per dialect (enables compiled queries & caching) |
| **Testability** | Every subsystem behind an interface; in-memory provider for unit tests |

---

## 3. Public API Design

### 3.1 Defining a Context

```ts
class AppDbContext extends DbContext {
  users = this.set(User);
  posts = this.set(Post);

  protected onModelCreating(model: ModelBuilder) {
    model.entity(User, e => {
      e.toTable('users');
      e.hasKey(x => x.id);
      e.property(x => x.email).hasMaxLength(320).isRequired().hasIndex({ unique: true });
      e.hasMany(x => x.posts).withOne(p => p.author).hasForeignKey(p => p.authorId);
      e.ownsOne(x => x.address);                      // owned type / value object
      e.hasQueryFilter(x => x.deletedAt.isNull());     // global filter (soft delete)
      e.property(x => x.rowVersion).isConcurrencyToken();
    });
  }
}
```

### 3.2 Querying

```ts
const db = new AppDbContext(config);

const users = await db.users
  .include(x => x.posts)                 // typed: only navigations accepted
  .thenInclude(p => p.comments)
  .where(x => x.age.gt(18).and(x.name.startsWith('A')))
  .orderBy(x => x.name)
  .skip(20).take(10)
  .toList();

const dto = await db.users
  .where(x => x.isActive.eq(true))
  .select(x => ({ id: x.id, postCount: x.posts.count() }))   // typed projection
  .toList();

const page = await db.users.orderBy(x => x.id).toPage(2, 25); // { items, total, page, pageSize }

const n = await db.users.where(x => x.age.gte(65)).count();
```

### 3.3 Mutation & Unit of Work

```ts
const user = await db.users.find(42);          // identity-map aware
user.name = 'New Name';                        // snapshot tracker detects change

db.users.add(new User({ ... }));
db.users.remove(staleUser);                    // soft-deletes if configured

await db.saveChanges();                        // one transaction, ordered writes
```

### 3.4 Escape Hatches

```ts
await db.users.fromSql`SELECT * FROM users WHERE tenant_id = ${tid}`.toList(); // tagged template → parameterized
await db.database.executeSql`UPDATE ...`;
await db.database.transaction(async tx => { ... });
```

---

## 4. Monorepo Structure

pnpm workspaces + Turborepo for task orchestration; Changesets for versioning.

```
repo/
├─ packages/
│  ├─ core/                 # metadata, expressions, tracking, UoW, DbContext/DbSet — NO engine dependency
│  ├─ engine-kysely/        # IQueryExecutor/ISqlGenerator implemented over Kysely's OperationNode AST
│  ├─ engine-native/        # (post-1.0, reserved) raw-driver engine: pg / mysql2 / better-sqlite3 / tedious
│  ├─ postgres-provider/    # dialect: RETURNING, jsonb, ILIKE, identity, advisory locks
│  ├─ mysql-provider/       # dialect: last_insert_id, ON DUPLICATE KEY, no RETURNING (<8.0.21 quirks)
│  ├─ sqlite-provider/      # dialect: rowid, limited ALTER TABLE (migration table-rebuild strategy)
│  ├─ mssql-provider/       # dialect: OUTPUT, TOP/OFFSET-FETCH, rowversion
│  ├─ migrations/           # model differ, migration generator, runner, snapshot store
│  ├─ cli/                  # `orm migrations add`, `orm database update`, scaffolding, diagnostics
│  ├─ decorators/           # @Entity, @Column, @HasMany… → emits same ModelBuilder calls
│  ├─ testing/              # in-memory provider, SQL assertion helpers, fixture builders
│  ├─ examples/             # blog app, multi-tenant SaaS, monorepo-per-dialect samples
│  └─ docs/                 # docs site source (see §16)
├─ turbo.json  pnpm-workspace.yaml  tsconfig.base.json
```

**Dependency rule (enforced by lint):** `core` depends on nothing in the workspace. Dialect providers depend on `core` + `engine-kysely` (never on Kysely directly). `migrations` depends on `core`. `cli` depends on `migrations` + providers via dynamic loading. This keeps the core tree-shakeable and testable without a database.

---

## 5. Internal Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                        Consumer Application                        │
└───────────────▲────────────────────────────────▲───────────────────┘
                │ entities (POCOs)               │ fluent config
┌───────────────┴────────────────────────────────┴───────────────────┐
│  DbContext ── owns ──▶ ChangeTracker (identity map, snapshots, UoW)│
│      │                                                             │
│      ├─ set(User) ──▶ DbSet<User> (thin, stateless façade)         │
│      │                   │ where/include/select…                   │
│      │                   ▼                                         │
│      │              Queryable<T>  (immutable; each call returns a  │
│      │                   │         new Queryable wrapping IR)      │
│      │                   ▼                                         │
│      │        Expression IR ─ Normalizer ─ Optimizer               │
│      │                   ▼                                         │
│      │             ISqlGenerator ◀── dialect overrides             │
│      │                   ▼                                         │
│      │             IQueryExecutor (engine-kysely)                  │
│      │                   ▼                                         │
│      │               Kysely ──▶ node drivers ──▶ Database           │
│      │                   ▲                                         │
│      └── saveChanges ────┘ (batched INSERT/UPDATE/DELETE)          │
│                                                                    │
│  Cross-cutting: Interceptors · Events · Logging · Plugins · DI     │
└────────────────────────────────────────────────────────────────────┘
```

**How DbContext works.** A `DbContext` instance is a *unit-of-work scope*: it holds (a) a reference to the frozen `ModelSnapshot` (shared across all instances of that context class), (b) its own `ChangeTracker`, and (c) a `DatabaseFacade` bound to the provider. Construction is cheap — metadata is built once per class, cached at module level, and validated eagerly (bad mappings fail at boot, not at query time). `this.set(User)` looks up the `EntityType` in the snapshot and returns a memoized `DbSet<User>`.

**How DbSet works.** `DbSet<T>` is stateless: it is simultaneously (1) the root `Queryable<T>` (calling `.where()` on it forks an immutable query object — sets are never mutated by querying) and (2) the tracker entry point (`add/remove/attach/find` delegate to the context's ChangeTracker). Because Queryables are immutable value objects over the IR, they are safely shareable, cacheable, and hashable.

---

## 6. Query Subsystem: From Lambda to SQL

### 5.1 Expression Capture — the Engineering Decision

Three candidate strategies were evaluated:

| Strategy | Type safety | Runtime robustness | EF-likeness | Verdict |
|---|---|---|---|---|
| **A. Parse `fn.toString()`** | ✅ (real lambdas) | ❌ minifiers, transpilers, closures break it | ✅✅ | Rejected |
| **B. Proxy recorder + operator methods** | ✅✅ | ✅✅ | ✅ (`x.age.gt(18)`) | **Chosen** |
| **C. Plain object DSL** (`{ age: { gt: 18 } }`) | ✅ | ✅✅ | ❌ (Prisma-like, not EF) | Fallback sugar only |

With Strategy B, `where(x => …)` invokes the lambda **once at query-build time** with a `Proxy<EntityRef<T>>`. Property access returns typed `FieldRef<TProp>` nodes; calling `.gt(18)` returns a `BoolExpr` node. The lambda's return value *is* the expression tree — no source parsing, fully minification-safe, and the generic types on `FieldRef` give exact IntelliSense (e.g. `startsWith` only exists on `FieldRef<string>`).

Selectors that are *pure property paths* (`orderBy(x => x.name)`, `include(x => x.posts)`) also run against the proxy; the recorded access path (`['name']`, `['posts']`) is the tree. Nested paths (`x => x.address.city`) work because the proxy is recursive and metadata-aware (it refuses to descend into non-mapped members at runtime, and the types refuse at compile time).

### 5.2 Internal Expression Tree (IR)

A small, closed algebra — deliberately not general-purpose JS:

```
QueryExpr := Select(source, projection?, predicate?, orderings[], skip?, take?,
                    includes[], groupBy?, distinct?, aggregates[])
BoolExpr  := Binary(op, Expr, Expr) | Logical(and|or, BoolExpr[]) | Not | IsNull
            | Like | In | Exists(subquery) | RawPredicate(sql, params)
Expr      := Column(path) | Constant(value, dbType) | FunctionCall(name, Expr[])
            | Aggregate(count|sum|avg|min|max, Expr?) | Case(...) | Coalesce(...)
```

Every node is immutable and structurally hashable → the hash is the **query cache / compiled query key**.

### 5.3 Pipeline

```
 lambda ──proxy──▶ IR tree ──▶ Normalizer ──▶ Optimizer ──▶ SQL Generator ──▶ engine AST ───▶ dialect SQL
                               (apply global      (predicate     (visitor per      (parameter
                                filters, expand    pushdown,      IR node type)      binding)
                                owned types,       constant
                                resolve navs)      folding)
                                                                    │
 rows ◀── Materializer ◀── Shaper (split/JOIN result reassembly) ◀──┘
```

- **Normalizer** injects global query filters (unless `.ignoreQueryFilters()`), rewrites owned-type member access to prefixed columns, and converts navigation references in predicates into `EXISTS` subqueries or joins.
- **SQL Generator** is a classic visitor. It emits *Kysely `OperationNode`s*, not strings — the engine's per-dialect query compilers handle identifier quoting, parameter binding, and dialect syntax; our dialect providers override only the deltas (paging syntax, returning-clause strategy, ILIKE, etc.). Because both our IR and the engine AST are immutable trees, the lowering step is a pure function — trivially memoizable for compiled queries.
- **Shaper** handles `include`: for to-one navs → LEFT JOIN with column aliasing (`t1__posts__id`); for collections → **split queries by default** (parent query, then one `WHERE fk IN (…)` query per included collection level), avoiding cartesian explosion. `.asSingleQuery()` opts into JOIN mode.
- **Materializer** constructs entities, wires navigations both ways, registers everything in the Identity Map (unless `.asNoTracking()`), and stores snapshots.

### 5.4 Compiled Queries & Caching

```ts
const byEmail = compileQuery((db: AppDbContext, email: Param<string>) =>
  db.users.where(x => x.email.eq(email)).single());
```

`compileQuery` runs the pipeline once, caches the generated SQL + a fast materializer plan keyed by the IR hash, and returns a function that only binds parameters. A bounded LRU (default 1024 entries) performs the same memoization transparently for ad-hoc queries.

---

## 7. Metadata Model

Built once at first context construction per context class (thread-safe via module-level cache), then frozen.

```
ModelSnapshot
 ├─ EntityType[]           name, table, schema, keys (composite supported), discriminator (TPH)
 │   ├─ Property[]         column, dbType, nullability, defaults, valueConverter,
 │   │                     concurrencyToken?, generated (identity/computed)
 │   ├─ Navigation[]       kind (1:1, 1:N, N:M), inverse, FK properties, cascade behavior,
 │   │                     joinEntity? (for N:M — implicit join table synthesized if not mapped)
 │   ├─ OwnedType[]        flattened columns with prefix; tracked as part of owner's snapshot
 │   ├─ QueryFilter?       stored as IR BoolExpr, composed with AND at normalize time
 │   └─ Indexes[], CheckConstraints[]
 ├─ RelationshipGraph      adjacency of FK dependencies (drives save ordering & Include planning)
 └─ Conventions[]          pluggable: naming (camel→snake), FK discovery, pluralization
```

**Two configuration front-ends, one back-end:** the Fluent `ModelBuilder` is the source of truth; the `decorators` package simply replays `@Column`, `@HasMany` etc. into the same builder. Fluent wins on conflict (mirrors EF precedence: convention < decorator < fluent).

**Value objects / owned types:** an owned type has no key and no DbSet; its columns are flattened into the owner's table (`address_city`), it participates in the owner's snapshot, and equality is structural.

---

## 8. Change Tracking & Unit of Work

### 7.1 State Machine

```
            add()                    saveChanges()
 Detached ─────────▶ Added ────────────────────────▶ Unchanged
    ▲                                                   │  property mutated (snapshot diff)
    │ detach()                                          ▼
    └───────────── Deleted ◀──── remove() ◀──────── Modified
                      │ (Added + remove() ⇒ Detached, never hits DB)
```

### 7.2 Mechanics

- **Identity Map:** `Map<EntityType, Map<serializedKey, entry>>`. `find()` and every materialization consult it first — one instance per key per context. Composite keys serialize as an ordered tuple string.
- **Snapshot tracking (default):** on attach/materialize, a shallow-plus-owned deep snapshot of mapped properties is stored. `detectChanges()` (run automatically inside `saveChanges` and relationship fixup) diffs current vs snapshot. No property interceptors required → entities are plain classes, POCO-style.
- **Optional notify tracking:** entities may implement `INotifyChanged` (or use the decorator package's accessor-generating `@Tracked`) to skip full diffs on huge contexts.
- **Relationship fixup:** setting `post.author = user` also updates `user.posts` and marks `post.authorId` modified; the tracker reconciles FK values vs navigation references, FK wins ties (as in EF).
- Contexts are **short-lived and not thread-safe** (same guidance as EF). A pooled-context factory (`addDbContextPool`) is provided for hot paths.

### 7.3 saveChanges() Pipeline

```
detectChanges → validation pipeline → saving interceptors → build op list
   → topo-sort ops on RelationshipGraph (inserts parents→children, deletes children→parents)
   → BEGIN TRANSACTION (unless ambient tx supplied)
   → batch per (table, op-kind): multi-row INSERT with RETURNING/OUTPUT where dialect allows
   → write back generated keys & new rowversions → fix up FKs of dependents awaiting parent keys
   → concurrency check: UPDATE … WHERE key AND rowversion = @old; affected===0 ⇒ ConcurrencyError(entries)
   → COMMIT → set entries Unchanged, refresh snapshots → saved interceptors/events
```

Soft delete is implemented as a normalizer+saver plugin: `remove()` on a soft-delete entity rewrites the Delete op into an Update setting `deletedAt`, and the global filter hides it from queries.

---

## 9. Relationships, Include, and Loading Strategies

- **Eager (`include`/`thenInclude`):** planned at IR level; collections use split queries (§6.3). Filtered includes supported: `include(x => x.posts.where(p => p.published))`.
- **Explicit:** `db.entry(user).collection(x => x.posts).load()` / `.reference(x => x.profile).load()` — issues a targeted query and fixes up.
- **Lazy (opt-in):** enabling `lazyLoading: true` makes the materializer wrap entities in a Proxy whose navigation getters return… a problem: getters can't be async. **Decision:** lazy navigations are typed as `LazyRef<T>` / `LazyCollection<T>` with `await user.posts.load()` and a sync `.value` after load. We deliberately do not fake sync lazy loading — hiding I/O behind a property getter is a correctness hazard in Node.
- **Many-to-many:** implicit join entity synthesized by convention (`post_tags`), or explicit via `usingEntity(PostTag)` when payload columns are needed. The tracker manages join rows automatically when you mutate the collection.

---

## 10. Transactions

- `saveChanges()` is atomic by default.
- Explicit: `await db.database.transaction(async () => { …; await db.saveChanges(); … })` — an AsyncLocalStorage-based ambient transaction means all operations inside the callback share the engine transaction without threading a `tx` object through APIs. Nested calls become savepoints where the dialect supports them.
- Isolation levels and manual `begin/commit/rollback` exposed for advanced cases; `IExecutionStrategy` (retrying strategy for transient failures, e.g. Postgres serialization errors) is pluggable per provider.

---

## 11. Migrations

```
onModelCreating ──▶ ModelSnapshot ──diff──▶ prior snapshot (checked into repo as .snapshot.json)
                                     │
                                     ▼
                     MigrationOperations[] (CreateTable, AddColumn, AddFK, CreateIndex, …)
                                     │  (up + auto-derived down)
                                     ▼
                  TS migration file (class with up(builder)/down(builder))
                                     │
        `orm database update` ──▶ Runner: acquire migration lock → read __orm_migrations
                                  history table → apply pending in tx (per-dialect DDL-in-tx
                                  awareness: MySQL can't roll back DDL → warn + journal)
```

- **Model differ**, not database differ: deterministic, works offline, identical to EF's approach. Snapshot merge conflicts are handled by a `orm migrations repair` command.
- Destructive-change detection prompts (or `--force`); SQLite provider implements column drops/renames via table-rebuild.
- **Seeding:** `model.entity(Role, e => e.hasData([...]))` participates in the diff (seed changes generate migrations), plus a runtime `db.seed()` hook for environment-specific data.
- `orm migrations script --idempotent` emits SQL scripts for DBA-gated deployments.

---

## 12. Dependency Injection & Lifecycle

Core ships DI-agnostic with a tiny composition API:

```ts
const provider = createPostgresProvider({ connection, pool: { min: 2, max: 10 } });
const factory  = createContextFactory(AppDbContext, { provider, logging, interceptors });
// per request:
await using db = factory.create();   // Symbol.asyncDispose → releases pooled context
```

Adapters for NestJS (`@Module` + request-scoped provider), Fastify/Express middleware, and InversifyJS live in small companion packages. Connection pooling itself is delegated to the engine's pool (tarn/pg-pool per dialect); context pooling (reset-and-reuse of tracker structures) is ours.

---

## 13. Cross-Cutting: Interceptors, Diagnostics, Plugins, Multi-Tenancy

- **Interceptors** (ordered pipeline, sync or async): `commandCreating/Executed`, `saving/savedChanges`, `transactionStarted/Committed`, `materialized`. Uses: query hints, audit stamps, RLS session variables.
- **Events:** typed emitter (`entityAdded`, `queryCompiled`, `migrationApplied`) for observability without behavior change; interceptors for behavior change.
- **Logging & metrics:** structured log events with SQL, parameters (redactable), duration, rows; adapters for pino/winston; OpenTelemetry spans out of the box; slow-query threshold warnings; `EXPLAIN` capture in diagnostics mode.
- **Validation pipeline:** `validate()` hook on entities + registered validators run before save; integrates with zod/class-validator via adapters.
- **Plugin architecture:** a plugin can register conventions, IR normalizer passes, interceptors, materializer hooks, and CLI commands. Soft delete, timestamps (`createdAt/updatedAt`), and multi-tenancy ship as first-party plugins proving the surface.
- **Multi-tenancy:** plugin offering (a) discriminator-column mode — injects `tenantId` filter + write-time stamping from an `ITenantProvider` (AsyncLocalStorage), (b) database-per-tenant mode — factory resolves provider/connection per tenant with per-tenant migration orchestration in the CLI.

---

## 14. Implementation Roadmap

Each phase ends green: shippable, tested, documented.

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Core abstractions** | `DbContext`, `DbSet`, provider interfaces, config plumbing | Context instantiates; in-memory provider echoes ops |
| **2. Metadata** | ModelBuilder fluent API, conventions, ModelSnapshot, composite keys, owned types | Snapshot serialization round-trips; 100% branch coverage on conventions |
| **3. Expression system** | Proxy recorder, IR algebra, hashing, normalizer | Property paths & predicates capture correctly under minification tests |
| **4. Query pipeline** | SQL generator lowering IR → Kysely AST, where/order/paging/projection/aggregates, materializer | SQL snapshot tests pass on PG+SQLite; `toList/single/count/toPage` |
| **5. Change tracking + UoW** | Identity map, snapshots, state machine, `saveChanges`, transactions, batching, concurrency tokens | CRUD integration suite green on all 4 dialects |
| **6. Relationships** | Navigations, fixup, Include/ThenInclude (split + join), explicit loading, N:M | Blog example app runs end-to-end |
| **7. Filters & plugins** | Global filters, soft delete, interceptors, events, validation, logging/metrics | Plugin API frozen (semver) |
| **8. Migrations + CLI** | Differ, generator, runner, seeding, idempotent scripts | Migrate the example app schema forward/back on all dialects |
| **9. Advanced** | Compiled queries, query cache, lazy loading, raw SQL, decorators pkg, multi-tenancy, MSSQL polish, scaffolding | Benchmarks published; 1.0-rc |

Parallelization: Phases 2–3 are independent after 1; migrations (8) can start against the Phase-2 snapshot format.

---

## 15. Testing Strategy

- **Unit (vitest):** expression capture, IR normalization, metadata conventions, tracker state machine — all against the in-memory provider; **SQL snapshot tests** assert generated SQL per dialect without a database.
- **Integration:** Testcontainers matrix (Postgres 14/16, MySQL 8, MSSQL 2022) + in-process SQLite; the *same* behavioral suite runs against every dialect ("compatibility suite") — any provider must pass it to claim support.
- **Property-based tests** (fast-check): random IR trees → generated SQL must parse and round-trip semantics on SQLite reference.
- **Performance:** benchmark package comparing against raw Kysely, Prisma, MikroORM, TypeORM, Drizzle — query build time, materialization rows/sec, saveChanges batch throughput; CI regression gate at ±10%.
- **Type tests** (`tsd`/vitest `expectTypeOf`): illegal includes, wrong operator on type, projection shape inference — the type system *is* API surface, so it gets its own suite.
- **Migration tests:** apply → assert schema (information_schema introspection) → down → assert original.

---

## 16. Documentation Plan

Docusaurus site, versioned:

1. **Getting started** — 10-minute quickstart per dialect.
2. **Guides** — modeling, querying, tracking & saving, relationships, migrations, transactions, testing your app, performance tuning.
3. **"Coming from EF Core"** — a side-by-side translation table (this is the growth engine for the target audience).
4. **API reference** — generated via TypeDoc from source.
5. **Architecture guide** — this document, maintained, with ADRs (Architecture Decision Records) for every consequential choice (expression strategy, split queries, lazy `LazyRef`, etc.).
6. **Contributing** — provider-author guide (how to pass the compatibility suite), plugin-author guide, release process (Changesets), code of conduct.
7. **Cookbook/examples** — runnable apps in `packages/examples`.

---

## 17. Project Names (15 Candidates)

> **Decision (2026-07-08): `Ormit` selected** — see the implementation plan, Appendix C, for availability verification and rationale. The table below is retained as the evaluation record.

| Name | Why it fits |
|---|---|
| **Contextly** | Centers the `DbContext` concept; friendly npm-able name |
| **EntiKit** | "Entity toolkit"; short, professional, unclaimed |
| **Trackline** | Evokes change *tracking* + query pipe*line* |
| **Ormit** | ORM + kit; tiny, memorable, CLI-friendly (`ormit migrate`) |
| **Quivver** | Plays on *query* + IQueryable; distinctive spelling avoids clashes |
| **Statecraft ORM** | Change tracking = managing entity *state*, with a nod to craftsmanship |
| **Fluentity** | Fluent API + entity; describes the config experience exactly |
| **Kontext** | The K nods to Kysely under the hood while keeping DbContext front-and-center |
| **Efude** | "EF" homage + Japanese *e-fude* (picture brush) — you paint queries |
| **Coreline** | "EF-Core-like pipeline"; sounds infrastructural and stable |
| **Entura** | Entity + ventura; smooth, brandable, domain-available energy |
| **Snapshot ORM (Snaptrack)** | Names the core mechanism — snapshot change tracking |
| **Relior** | RELational + prior/reliable; serious, enterprise tone |
| **Mappa** | Latin "map" — object-relational *mapping*, short and clean |
| **Tessella** | A tessella is one tile of a mosaic — entities composing a model; elegant, rare on npm |

(Registry check 2026-07-08: `ormit`, `entura`, `relior`, `efude`, `quivver`, `trackline` free; `tessella`, `fluentity`, `kontext`, `mappa`, `contextly` taken.)

---

## 18. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Proxy-based expressions feel "almost EF but not quite" | Invest in `FieldRef` operator ergonomics + the EF-migration guide; keep object-DSL sugar as fallback |
| Cartesian explosion with JOIN includes | Split queries by default (EF 5+ lesson learned) |
| Kysely `OperationNode` AST is semi-internal API | Pin minor versions; SQL snapshot suite catches compile drift on upgrade instantly; `engine-native` escape hatch (ADR-002) |
| Kysely maintenance stalls | Engine interface isolates it; `engine-native` over raw drivers is feasible without public API change |
| Type-level complexity slows `tsc` for users | Budget: typecheck of a 50-entity model < 3s; type tests include compile-time perf gates |
| Migration snapshot merge conflicts in teams | `migrations repair` command + docs; snapshot format designed for mergeability (sorted keys, one entity per block) |

---

## Appendix A — Architecture Decision Records

### ADR-001: Expression Capture via Typed Proxy Recorder

**Status:** Accepted. **Context/Decision/Consequences:** see §6.1. Recorded here for index completeness.

### ADR-002: Query Engine Selection — Kysely over Knex

**Status:** Accepted · **Date:** 2026-07 · **Supersedes:** initial brief's Knex assumption

**Context.** The ORM generates SQL from its own expression IR; the engine's job is dialect grammar, identifier quoting, parameter binding, and driver adaptation. Candidates: Knex, Kysely, Drizzle-as-engine, template-tag libraries, raw drivers.

**Decision.** Adopt **Kysely** as the sole 1.0 engine, consumed exclusively through `ISqlGenerator`/`IQueryExecutor` in the `engine-kysely` package. Reserve `engine-native` (raw drivers: `pg`, `mysql2`, `better-sqlite3`, `tedious`) as a post-1.0 performance track.

**Rationale.**
1. *Architectural congruence:* Kysely is an immutable SQL AST (`OperationNode`) with per-dialect compilers and driver adapters — the same shape as our pipeline. Our SQL Generator lowers IR → `OperationNode` mechanically. Knex is a mutable, stringly-typed builder we would fight.
2. *Maintenance & ecosystem:* Kysely is actively maintained with first-party PG/MySQL/SQLite/MSSQL dialects and a clean community `Dialect` interface; Knex's pace has slowed.
3. *Weight:* Knex bundles migrations, seeds, and pooling opinions we replace anyway; we would use ~30% of it and carry 100%.
4. *Type safety:* Kysely's celebrated compile-time typing is wasted on us (our IR is the typed layer) — but its runtime AST is exactly what we need. This "waste" costs nothing.

**Rejected alternatives.**
- *Knex:* maintenance risk, string internals, dead weight. Acceptable MVP engine, wrong 1.0 foundation.
- *Drizzle as engine:* an ORM with a welded-in builder; schema definitions leak into its query layer; embedding one ORM in another creates dependency and identity friction.
- *Template-tag libraries:* no AST, no dialect abstraction; the visitor would concatenate strings.
- *Raw drivers first:* front-loads the least differentiated, highest-risk work (escaping, quoting, dialect edge cases) before the differentiating subsystems are validated. Deferred, not rejected — see Consequences.

**Consequences.**
- Package rename: `knex-provider` → `engine-kysely`; dialect provider packages become thin quirk-overlays on it.
- Kysely's AST is semi-internal: pin minor versions; the cross-dialect SQL snapshot suite is the tripwire for compile drift on upgrades.
- DDL: our migrations package lowers `MigrationOperations` itself; the engine only executes DDL and reports DDL-in-transaction capability — so Kysely's thinner schema builder is a non-issue.
- `engine-native` (Postgres first) enters the post-1.0 roadmap, gated on benchmarks showing compiled-query or pipelining wins that justify owning dialect grammar.
- Compatibility-suite rule extends to engines: any engine package must pass the same behavioral suite as dialect providers.

---

*End of architecture document. Next step: Phase 1 scaffolding (`core` + `engine-kysely` skeletons) against ADR-001/ADR-002.*
