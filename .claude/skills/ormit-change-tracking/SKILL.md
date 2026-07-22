---
name: ormit-change-tracking
description: Write path internals of @ormit/core — ChangeTracker identity map, snapshot diffing, EntityEntry state machine, planSave topological ordering, and DbContext.saveChanges transaction/concurrency flow. Use when touching add/attach/remove/find, saveChanges, cascade deletes, concurrency tokens, or value-converter round-tripping on write.
---

# Ormit change tracking & unit of work (ADR-005)

## State machine — [tracking/tracker.ts](packages/core/src/tracking/tracker.ts)

`EntityState = 'Detached' | 'Added' | 'Unchanged' | 'Modified' | 'Deleted'`.

`ChangeTracker` holds two maps: `byRef` (identity map keyed by object reference —
the source of truth for state) and `identityMap` (keyed by
`entityName + JSON(keyValues)` string, only populated once **all** key values are
non-null/undefined — new entities without an assigned key aren't identity-mapped
until after insert + `acceptChanges`).

- `track(entity, name, state)` — re-states if already tracked (by ref), else creates
  an `EntityEntry` with a `scalarSnapshot()` baseline.
- `registerQueried()` — the dedup point for query results: if the identity map
  already has this key, **returns the existing tracked object**, discarding the
  freshly materialized one, so in-flight edits on an entity aren't clobbered by a
  second query hitting the same row.
- `remove()` — Added+removed ⇒ instantly `Detached` (never hits the DB); anything
  else ⇒ `Deleted`.
- `detectChanges()` — diffs `Unchanged`/`Modified` entries against their snapshot via
  `EntityEntry.modifiedProperties()`; called **twice** per `saveChanges()` (once
  before interceptors run, once after — interceptors may re-state entries, e.g.
  soft-delete rewriting Deleted→Modified).
- `acceptChanges()` — post-save: `Deleted` → detach; `Added`/`Modified` → `Unchanged`
  + `refreshSnapshot()` + re-key in the identity map (an insert's key is only known
  now, after write-back).

**What counts as a scalar** (diffed) vs. a navigation (ignored):
`isScalar()` = `null | string | number | boolean | bigint | Date`. A property is
also diffed if its name is in the entity's *converted* set (`hasConversion()`
properties, cached per entity name in `convertedByEntity`) — converted values may be
arrays/objects but still map to one column, compared with `structuralEquals()`
(JSON-string equality, Dates by `getTime()`) instead of `===`.

## Save planning — [tracking/save.ts](packages/core/src/tracking/save.ts)

`planSave(tracker, model, converters)` is pure (no I/O) and independently testable.
Order: **inserts parent→child, updates unordered, deletes child→parent** — both via
`topoSort(model)` (line ~230), a DFS over the FK dependency graph (`!nav.collection`
⇒ declaring entity depends on target; `nav.collection` ⇒ target depends on declaring
entity; owned navs are skipped, they share the owner's row). Cycles are silently
ignored (`inStack` guard breaks re-entry) rather than throwing.

- `buildUpdate()` — only **changed** columns go in `values` (via
  `entry.modifiedProperties()`), never the full row.
- `rowPredicate()` — key columns pinned to **current** values, plus (if the entity
  has a `concurrencyToken` property) that column pinned to its **snapshot
  (original)** value — a stale in-memory concurrency token can't silently overwrite
  a row someone else changed.
- `cascadeFor()` (line ~68) — for every **non-owned** collection navigation with
  `deleteBehavior: 'cascade' | 'setNull'`, emits a bulk delete/update step **before**
  the principal's own delete step. `restrict`/`noAction` defer to the DB (no step
  emitted — a real FK constraint must exist for these to actually protect anything).
- Every value written or predicated goes through `toDb()` (the property's converter,
  if any) — see [metadata/converters.ts](packages/core/src/metadata/converters.ts).

## Orchestration — [context/db-context.ts](packages/core/src/context/db-context.ts) `saveChanges()` (line ~304)

```
detectChanges()
→ interceptors.savingChanges (plugins may re-state entries, e.g. soft-delete)
→ detectChanges() again
→ if no changes: return 0
→ planSave() → topo-ordered SaveStep[]
→ per step: compileWrite → interceptors.commandExecuting → executor.execute
            → interceptors.commandExecuted
            → if step.concurrency && result.affected === 0: throw ConcurrencyError
            → on insert: write generated key back onto the tracked entity object
→ (all steps run inside executor.transaction, ambient via AsyncLocalStorage —
   a nested DbContext.database.transaction() call joins instead of nesting)
→ acceptChanges()
→ interceptors.savedChanges
```

A **zero-affected-rows** result on any step marked `concurrency: true` (every
update/delete) throws `ConcurrencyError` carrying the offending `EntityEntry` — this
is the *only* concurrency detection mechanism; there's no optimistic-lock retry
built in.

`entry<T>(entity)` ([db-context.ts:219](packages/core/src/context/db-context.ts))
begins tracking an untracked entity as `Unchanged` and wires its `.loader` for
explicit navigation loading (`entry.reference(nav).load()` /
`entry.collection(nav).load()`, both no-ops if `.loader` is never set, i.e. the
entity was never obtained through a `DbContext`).
