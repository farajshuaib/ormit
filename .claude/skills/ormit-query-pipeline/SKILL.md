---
name: ormit-query-pipeline
description: Read path internals of @ormit/core — expression recorder, IR nodes, normalize/optimize pipeline, Queryable/OrderedQueryable, compiled-query cache, and split-query eager loading (Include/ThenInclude). Use when touching where/orderBy/select/include, adding a new operator or IR node kind, or debugging query translation/caching.
---

# Ormit query pipeline (read path)

Data flow (all pure IR→IR until the engine boundary):

```
lambda → recorder (Proxy)      →  BoolExprNode / path / projection
       → Queryable method       →  SelectExpr (forked, immutable)
       → prepareSelect          =  normalize (query filters + column resolution)
                                   + plugin normalizerPasses
                                   + optimize (const-fold/simplify predicate)
       → irHash(prepared)       →  LRU lookup (Lru<string, CompiledCommand>)
       → ISqlGenerator.compileSelect  (miss only)
       → IQueryExecutor.query
       → materializeTracked     →  identity-map registration (unless asNoTracking/projection)
       → loadIncludes           →  split queries for Include/ThenInclude
```

## Expression recorder — [recorder.ts](packages/core/src/expressions/recorder.ts)

`where`/`orderBy`/`select`/`include` selectors run the lambda **exactly once** against
a `Proxy`-based `EntityRef<T>` (ADR-001). No `fn.toString()` — minification-safe.
Two internal symbols carry state on every proxy: `PATH` (property-path so far) and
`EXPR` (the `ValueExpr` node). `operatorFor()` (line ~111) dispatches method names
(`eq`, `gt`, `in`, `isNull`, `startsWith`, `toLower`, `count`, `any`, `all`, …) to IR
builders. `toLower()/toUpper()` return a *computed* `makeValue()` proxy (no further
path descent) so chains like `x.name.toLower().eq('a')` still work — operators are
built over `ValueExpr`, not a bare path.

- `recordPath` — requires the selector return a pure property path (orderBy/include);
  throws `TranslationError` on a computed value.
- `recordProjection` — `select(x => ({...}))` must return an object literal of paths;
  each value must itself be a path (no computed projections yet).
- `recordPredicate` — requires a `BoolExpr` (has `.node`); plain booleans are rejected.

**Known gap:** `any()/all()/count()` on a collection navigation build `exists` /
`subaggregate` IR nodes (recorder.ts:140-156), and the optimizer/normalizer only
recurse into their nested predicate — nothing lowers them into an actual correlated
subquery/JOIN yet. `engine-kysely`'s `lower()`/`value()` **throw `TranslationError`**
for both node kinds ("must be normalized before lowering"). They're currently
IR-only, covered by recorder-level unit tests (`core/test/operators.test.ts`), never
end-to-end against a real SQL generator. Don't assume `.any()/.all()/.count()` works
past IR construction without adding that lowering pass first.

## IR — [ir/nodes.ts](packages/core/src/ir/nodes.ts), [ir/hash.ts](packages/core/src/ir/hash.ts)

`SelectExpr` is the root read node: `entity, predicate?, orderings, skip?, take?,
projection?, distinct?, aggregate?, includes?`. `BoolExprNode` union: `binary |
logical | not | nullcheck | like | in | exists | lit`. `ValueExpr` union: `column |
constant | function | subaggregate`. `IncludeNode` carries `navigation, target,
collection, foreignKey, principalKey, filter?, children` (children = ThenIncludes).

`irHash()` = FNV-1a over `canonical()` JSON (object keys sorted recursively, arrays
in order) — the cache key AND compiled-query key. Golden-tested in
`core/test/hash.test.ts`; **changing `canonical()` breaks the golden on purpose** —
don't touch it casually.

## Normalize — [pipeline/normalizer.ts](packages/core/src/pipeline/normalizer.ts)

Two passes, both metadata-aware and lenient (unmapped paths pass through unchanged
rather than erroring):
1. `injectQueryFilters` — ANDs the entity's stored `queryFilter` into the predicate
   unless `ignoreQueryFilters()` was called. This is how soft-delete's global filter
   gets applied to every query.
2. `resolveColumns` / `resolveColumnPath` — rewrites paths through **owned, non-collection**
   navigations into their flattened physical column (`address.city` →
   `address_city`); paths through *regular* navigations are left alone (no join
   layer exists — see gap above). Also runs filter constants compared against a
   converted column through `converter.toProvider()` (`convertConstant`, line ~172)
   so `where(x => x.status.eq(Status.Active))` filters on the stored representation.

## Optimize — [pipeline/optimizer.ts](packages/core/src/pipeline/optimizer.ts)

Pure predicate simplification: constant-fold `binary`/`nullcheck`/`in` into `lit`;
flatten nested and/or of the same op; drop identity literals, short-circuit on
absorbing ones; `¬¬x → x`. `conjuncts()` flattens an AND-tree into independent
clauses (declared as a pushdown enabler, but nothing currently consumes it outside
tests — no join/pushdown layer exists yet).

`prepareSelect()` ([prepare.ts](packages/core/src/pipeline/prepare.ts)) is the
composition point: `normalize → plugin normalizerPasses → optimize`, and if the
predicate optimizes to `lit(true)` it's dropped entirely from the `SelectExpr`
(cleaner cache keys / SQL). Shared by `Queryable` terminals and the include loader's
follow-up queries.

## Cache — [pipeline/cache.ts](packages/core/src/pipeline/cache.ts)

`Lru<K,V>` — plain `Map` with delete+reinsert for recency, capacity eviction of the
oldest key. One instance per `DbContext` (`queryCache`, capacity 1024), keyed by
`irHash`. A hit skips normalize+optimize+generate entirely — safe because constants
are part of the IR (and thus the hash), so no query-shape collision can share wrong
params.

## Queryable — [context/queryable.ts](packages/core/src/context/queryable.ts)

Immutable; every method (`where/orderBy/skip/take/distinct/include/select/
asNoTracking/ignoreQueryFilters`) calls `fork()` and returns a **new** `Queryable`
wrapping a patched `SelectExpr`. `orderBy`/`orderByDescending` return
`OrderedQueryable<T>` (unlocks `thenBy`/`thenByDescending` — mirrors EF's
`IOrderedQueryable`, so `thenBy` before `orderBy` doesn't type-check).

- `PlanContext` (optional — absent for raw queryables) carries `snapshot, options,
  cache?, tracker?, entityName?, services?, normalizerPasses?, converters?`.
- `select()` drops the tracker from the forked plan — **projections are never
  tracked** (line ~216).
- `fromSql()` (on `DbSet`, [db-context.ts:128](packages/core/src/context/db-context.ts))
  produces a `rawCommand`-carrying `Queryable` that is **terminal** — any further
  chained operator throws via `assertComposable()`.
- Terminals: `toList/first/firstOrNull/single/singleOrNull/count/any/sum/avg/min/max/
  toPage`. `single()`/`singleOrNull()` fetch `take: 2` to detect and reject a
  non-unique result cheaply. `toPage()` runs `skip+take` and `count()` in parallel.
- `include()`/`thenInclude()` build an `IncludeNode` tree via an internal
  `IncludeCursor` (path of child indices); `thenInclude` without a preceding
  `include` throws `TranslationError`.

## Split-query eager loading — [context/include-loader.ts](packages/core/src/context/include-loader.ts)

Deliberately **not** a JOIN (ADR-003, avoids row explosion). Each `IncludeNode` runs
one follow-up `WHERE fk IN (...)` query and stitches results into the roots'
navigation property in-memory (`Map` grouping for collections, `Map` lookup for
references). Recurses into `children` (ThenIncludes) using the just-loaded targets
as the new roots. `onLoad()` hook feeds `DbContext`'s N+1 detector
(`N_PLUS_ONE_THRESHOLD = 10` single-entity loads of one type ⇒ `OMT2001` warning,
see [db-context.ts:270](packages/core/src/context/db-context.ts)).
