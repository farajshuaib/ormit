---
name: ormit-integration
description: Ormit's integration/glue layer — context factory pooling, explicit lazy loading (LazyRef/LazyCollection), @ormit/decorators replay-into-ModelBuilder surface, @ormit/adapters (Express/Fastify/NestJS request lifecycle), and @ormit/testing's InMemoryEngine. Use when touching per-request DbContext lifecycle, decorator-based model config, framework middleware, or writing tests against the in-memory engine.
---

# Ormit integration surface

## Context factory & pooling — [core/src/context/factory.ts](packages/core/src/context/factory.ts)

`createContextFactory(ctor, { engine, poolSize? })` returns `{ create, release,
scoped }`. Pooling is a plain array (`idle: C[]`) used as a stack; `release()` calls
`context[Symbol.asyncDispose]()` (clears tracker + query cache + sets map, see
`DbContext`) **before** possibly returning it to the pool — identity maps never leak
across logical uses of a pooled instance. `scoped(work)` is the recommended
try/finally wrapper. Contexts are documented as **not concurrency-safe** — never
share one across concurrent requests, pooling only reuses the allocation, not a live
instance.

## Explicit lazy loading — [core/src/context/lazy.ts](packages/core/src/context/lazy.ts) (ADR-004)

`LazyRef<T>`/`LazyCollection<T>` wrap an async loader with memoized `.load()`
(loads once, `.loaded`/`.current` inspect state without triggering a load). No
synchronous property getter secretly hits the database — the design deliberately
rejects that EF/lazy-proxy pattern. Constructed by
`DbContext.lazyReference()`/`.lazyCollection()`, which internally call the same
private `.load()` used by `entry.reference(nav).load()`.

## Decorators — [decorators/src/index.ts](packages/decorators/src/index.ts)

Legacy-decorator-shape (`(target, propertyKey)`), works as plain functions too — **no
`reflect-metadata`, no runtime type reflection**. Each decorator just appends to a
module-level `registry: Map<Ctor, EntityMeta>` (`@entity()`, `@key()`, `@column()`,
`@hasOne()`/`@hasMany()` with a **thunked** target — `() => Ctor<object>` — to allow
forward references between entities declared in different files). Nothing is
applied to the actual model until `applyDecorators(model, ctors?)` is called
explicitly inside `onModelCreating`, which **replays** the registry into the same
`ModelBuilder`/`EntityBuilder` fluent surface used everywhere else — this is what
preserves `convention < decorator < fluent` precedence: call `applyDecorators` first,
then any subsequent fluent calls on the same builder still win. `clearDecoratorRegistry()`
exists purely for test isolation (the registry is a module singleton).

## Framework adapters — [adapters/src/index.ts](packages/adapters/src/index.ts)

Depends only on `@ormit/core`; frameworks are typed **structurally**
(`ExpressResLike`, `FastifyLike`) so Express/Fastify/Nest are never actual
dependencies. All three follow the same shape: create a pooled context at
request-start, attach it, dispose at request-end.

- `ormitExpress(factory, property='db')` — middleware attaches `req[property]`,
  disposes on the response's `'finish'` **and** `'close'` events (covers both normal
  completion and an aborted connection).
- `ormitFastify(factory)` — a Fastify plugin function `(fastify, options, done)`;
  tracks the per-request scope in a `WeakMap<request, OrmitScope>` since Fastify
  hooks don't share a mutable request object the same way; disposes `onResponse`.
- `ormitNestProviders(ctor, options)` — returns two `NestProvider`s: a singleton
  `ORMIT_FACTORY` and a `REQUEST`-scoped provider for the context ctor itself
  (`useFactory: (factory) => factory.create()` — Nest's DI handles per-request
  instantiation; there's no explicit dispose call here, unlike Express/Fastify —
  Nest's request-scope teardown isn't wired to `factory.release()`, a gap worth
  checking before relying on pool reuse under Nest).

## InMemoryEngine — [testing/src/index.ts](packages/testing/src/index.ts)

A **real** `OrmEngine` (generator + executor) used by most of the unit-test suite in
place of a real dialect — gives real query semantics (predicate evaluation, sort,
skip/take, distinct, aggregates) with zero DB dependency. The "SQL" is a JSON
`Payload` string (`{type:'select'|'write', query|op, table}`) — `compileSelect`/
`compileWrite` just serialize IR to JSON; the executor `JSON.parse`s it back and
interprets the `SelectExpr`/`WriteOp` directly against in-memory `Row[]` tables
(`resolve()`/`evaluate()` mirror the IR semantics engine-kysely implements in SQL —
keep these two interpretations in sync when adding a new IR node kind, since
`InMemoryEngine` is the thing most tests actually exercise).

Gotchas: `compileRaw()` throws — **`fromSql()` is not testable against
`InMemoryEngine`**, use a real dialect (e.g. `@ormit/sqlite` in-memory) for that.
`exists`/`subaggregate` also throw here (same unimplemented-lowering gap as
engine-kysely — see [ormit-query-pipeline](../ormit-query-pipeline/SKILL.md)).
`transaction()` snapshots all table state up front and restores it wholesale on any
thrown error — a real rollback simulation, not just a no-op wrapper. `log: readonly
CompiledCommand[]` records every compiled command executed, useful for asserting
"exactly N queries ran" (N+1 detection tests, cache-hit tests).
