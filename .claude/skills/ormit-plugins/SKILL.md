---
name: ormit-plugins
description: The OrmPlugin extension surface in @ormit/core and the three first-party plugins in @ormit/plugins — soft-delete, timestamps, multitenancy. Use when writing a new plugin, wiring configureModel/normalizerPasses/interceptors, or modifying the soft-delete/timestamps/multitenancy behavior.
---

# Ormit plugin surface

Single contract — [core/src/plugins/types.ts](packages/core/src/plugins/types.ts):

```ts
interface OrmPlugin {
  readonly name: string;
  configureModel?(model: ModelBuilder): void;          // runs AFTER user's onModelCreating
  readonly normalizerPasses?: readonly NormalizerPass[]; // (select, model) => select
  readonly interceptors?: Partial<Interceptors>;         // savingChanges/savedChanges/commandExecuting/commandExecuted
}
```

`DbContext` wiring ([db-context.ts](packages/core/src/context/db-context.ts)):
`configureModel` for every plugin runs after `onModelCreating`, in plugin array
order, via `builder.configure()` (not `.entity()` — doesn't trip the duplicate-
registration diagnostic). `normalizerPasses` from all plugins are flattened once
into `pluginPasses` and threaded through `prepareSelect()` for every query
(`Queryable` reads and the include-loader's follow-up queries alike) — order matters
if two plugins' passes interact. `interceptors.savingChanges` runs once before the
first `detectChanges()` re-check in `saveChanges()`; `savedChanges` runs after
`acceptChanges()`; `commandExecuting`/`commandExecuted` wrap **every** compiled
write command (not reads).

The three first-party plugins are a deliberate dogfood proof that this surface is
sufficient — none of them reach into core internals beyond this contract.

## soft-delete — [plugins/src/soft-delete.ts](packages/plugins/src/soft-delete.ts)

`configureModel` attaches `hasQueryFilter(x => x[column].eq(false))` to every
targeted entity (default: every entity declared via `model.declaredCtors()`, i.e.
anything registered with `.entity()`, not just ones passed via `options.entities`).
This is why every read implicitly excludes soft-deleted rows unless the caller
opts out with `.ignoreQueryFilters()`.

`interceptors.savingChanges` rewrites: any entry in state `'Deleted'` whose entity
name is in the plugin's tracked `names` set gets `entity[column] = true` and its
state force-set to `'Modified'` — so `planSave()` emits an **UPDATE**, not a DELETE.
Note `names` is only populated during `configureModel` (mutates a closure `Set`), so
this plugin instance must actually run its `configureModel` before `saveChanges` can
correctly rewrite deletes — normal since `DbContext`'s constructor always calls it.

## timestamps — [plugins/src/timestamps.ts](packages/plugins/src/timestamps.ts)

Pure `interceptors.savingChanges`, no model changes. Stamps `createdAt`+`updatedAt`
on `'Added'` entries, `updatedAt` only on `'Modified'` ones. `now()` is injectable
(defaults to `() => new Date()`) specifically so tests can pass a fixed clock.
`entities` option restricts which entity names it applies to (default: all).

## multitenancy — [plugins/src/multitenancy.ts](packages/plugins/src/multitenancy.ts)

Discriminator-column mode (not schema-per-tenant). `tenant: () => unknown` is
resolved **per-operation** (typically backed by `AsyncLocalStorage` in the host
app), not cached — so one long-lived `DbContext`/pooled context can correctly serve
different tenants across requests. The `normalizerPasses` entry manually
constructs a `binary eq` IR node inline (not through the recorder) and ANDs it in
front of the existing predicate — a template for writing your own IR-manipulating
pass without going through `EntityRef`. `interceptors.savingChanges` stamps the
tenant column only on `'Added'` entries (never rewrites an existing row's tenant).

Both `entities` filters across plugins use the same pattern: `names ? Set.has : true`
(no restriction ⇒ applies everywhere) — copy this pattern for a new plugin's scoping
option rather than inventing another shape.
