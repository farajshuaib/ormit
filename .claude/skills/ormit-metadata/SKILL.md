---
name: ormit-metadata
description: Model metadata pipeline in @ormit/core — ModelBuilder/EntityBuilder fluent API, convention resolution (pluralization, key/FK discovery, type inference), finalize.ts's multi-phase snapshot builder, ModelSnapshot, OMT12xx validation diagnostics, stable serialization, and value converters. Use when adding/changing entity configuration surface, relationship/owned-type resolution, model validation rules, or anything touching ModelSnapshotData shape (migrations depend on it byte-for-byte).
---

# Ormit metadata & model finalization

Precedence: **convention < decorator < fluent**. Everything in `conventions.ts` is
only ever consulted for a slot the raw builder left `undefined`.

## Fluent surface — [metadata/builder.ts](packages/core/src/metadata/builder.ts)

`ModelBuilder` (implements `BuilderRegistry`) → `.entity(ctor, build?)` registers +
lets `EntityBuilder` configure; `.configure(ctor, build)` is the plugin entry point
— extends an already-declared entity **without** counting as a re-registration
(avoids the `OMT1203` duplicate-registration diagnostic that `.entity()` called
twice on the same ctor would trigger).

`RawEntity` is the *unprocessed* record: `properties: Map<string,RawProperty>`,
`navigations: RawNavigation[]`, `owned`/`ownedExplicit`, `keyExplicit`, etc. Every
`EntityBuilder` method just mutates this raw record — no validation happens here,
only in `finalize.ts`.

Relationship builders (`hasOne`→`ReferenceNavigationBuilder`,
`hasMany`→`CollectionNavigationBuilder`) record `withOne/withMany` (sets
`inverseCollection` + optionally `inverseName` via `recordPath` on the inverse
selector), `hasForeignKey`, `hasPrincipalKey`, `onDelete`, `isRequired`.
`ownsOne`/`ownsMany` mark the target `RawEntity.owned = true` and recurse a nested
`EntityBuilder` into it (`configureOwned`, line ~322).

## Conventions — [metadata/conventions.ts](packages/core/src/metadata/conventions.ts) (100% branch-coverage gated)

Pure functions, no side effects, each an explicit branch (deliberately verbose for
the coverage gate — don't refactor into something clever that collapses branches).
Notable ones:
- `pluralize()` — irregular map (person→people, etc.), uncountables (sheep, fish),
  consonant+y→ies, sibilant→es, fe/f→ves, else +s. Preserves leading case.
- `isKeyByConvention()` — `id`, or `<entityLower>id`, case-insensitive.
- `foreignKeyCandidates()` — ordered: `<nav><PK>`, `<nav>Id`, `<targetCamelCase><PK>`,
  `<targetCamelCase>Id`. `discoverForeignKey()` picks the first that exists on the
  dependent's known properties; if none exist, `finalize.ts` **synthesizes a shadow
  FK** using the first candidate (EF-style — this is why some model tests need
  `.hasType('number')`, since a shadow FK's CLR type defaults to `'unknown'`).
- `inferClrType()` — explicit type wins; else `maxLength` implies `'string'`; else
  classify a literal default value; else `'unknown'`. **No runtime reflection
  anywhere** — this is the sole source of a property's CLR type absent explicit
  config or decorators.
- `defaultDeleteBehavior()` — nullable FK ⇒ `setNull`, else `cascade`.

## Finalization — [metadata/finalize.ts](packages/core/src/metadata/finalize.ts) (~650 lines, the core validation engine)

`finalizeModel(builder)` runs in named phases over a `Map<string, Working>` (one
mutable `Working` record per entity, later frozen into `EntitySnapshot`):

- **Phase A** — classify owned-one targets (`ownedOne` map: target ctor name →
  `{owner, nav}`), resolve table names (owned-one inherits the owner's table +
  schema + gets a `columnPrefix` of `<nav>_` for flattening; owned-many and regular
  entities get their own table via `tableNameFor()` or an explicit `toTable()`).
- **Phase B** — gather every known property/key/discriminator name per entity (the
  set later used to validate seed rows, indexes, and FK candidate discovery).
- **Phase C** — `resolveKey()`: explicit `hasKey()` validated for duplicates/
  navigation-name collisions/owned-illegality (`OMT1210/1202/1216`); owned types get
  `key: []` (no independent identity); otherwise `discoverKey()` or `OMT1201`.
- **Phase D** — `resolveNavigation()` per raw navigation, branching on
  owned / many-to-many (`collection && inverseCollection`) / reference (to-one,
  **FK lives on the declaring entity**) / collection (one-to-many, **FK lives on
  the target/dependent side**, named after the inverse or `camelCase(principal)`).
  Each branch also pushes the *inverse* `NavigationSnapshot` onto the target's
  `navs` list when an inverse name was given.
- **Phase E** — `buildEntity()`/`buildProperty()` assemble the sorted, immutable
  `EntitySnapshot`; duplicate-column detection (`OMT1205`), nav/property name
  collision (`OMT1221`), index/seed/discriminator validation.
- **Phase F** — cross-entity: two non-owned entities sharing a table need
  **all-or-nothing** discriminator values (else `OMT1204`), and discriminator values
  within a shared table must be unique (`OMT1209`).

Entities are **sorted by name** before returning — this, plus recursively-sorted
JSON keys in `serialize.ts`, is what makes a snapshot byte-identical across a
round-trip regardless of `onModelCreating()` registration order.

## Snapshot — [metadata/snapshot.ts](packages/core/src/metadata/snapshot.ts), [types.ts](packages/core/src/metadata/types.ts), [serialize.ts](packages/core/src/metadata/serialize.ts)

`ModelSnapshot.build(builder)` throws `ModelValidationError` (all diagnostics
attached) if `finalizeModel` produced any. `ModelSnapshotData` is pure JSON — every
optional slot is an explicit `null`, never `undefined`/missing, so
`stableStringify()` (recursively sorted keys, fixed 2-space indent) round-trips
byte-for-byte. **The migrations differ consumes `ModelSnapshotData` directly and
diffs the committed `.snapshot.json` against it — never the live DB** — so any
change to a snapshot shape is effectively a migration-format change; bump
`SNAPSHOT_VERSION` (types.ts) deliberately, via ADR, not casually.

`Diagnostic` codes are `OMT12xx`, cataloged in
[metadata/diagnostics.ts](packages/core/src/metadata/diagnostics.ts) and mirrored in
[docs/diagnostics.md](docs/diagnostics.md) — keep both in sync when adding a code.

## Value converters — [metadata/converters.ts](packages/core/src/metadata/converters.ts)

A property's `hasConversion('name')` stores only the **name** in the snapshot (so
migrations stay byte-stable); the actual `{ toProvider, fromProvider }` functions
live in a runtime `ValueConverterRegistry` supplied via
`DbContextOptions.converters`, resolved by name at `DbContext` construction
(`assertConvertersRegistered()` fails fast if a property references an unregistered
name). Applied at three boundaries: write (`toDb`/`toProvider`), read
(`fromDb`/`fromProvider`), and query filter constants compared against a converted
column (`normalizer.ts`'s `convertConstant`). Built-ins: `jsonConverter`,
`booleanNumberConverter`, `isoDateConverter`.
