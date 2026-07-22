---
name: ormit-engine-kysely
description: IR-to-SQL lowering in @ormit/engine-kysely (the sole sanctioned `any` boundary) plus the four dialect executor packages (sqlite/postgres/mysql/mssql) — KyselySqlGenerator, per-dialect paging/RETURNING/DDL quirks, IQueryExecutor implementations, and transaction handling. Use when adding a new IR node kind, a new dialect, fixing SQL generation, or debugging dialect-specific paging/insert-key/transaction behavior.
---

# Ormit → Kysely SQL generation & dialect executors

## The `any` boundary — [engine-kysely/index.ts](packages/engine-kysely/src/index.ts)

The **only** place `any` is allowed in the workspace (ADR-002; enforced by
`scripts/check-deps.mjs`, which also enforces that only this package imports
`kysely`). `compileOnlyKysely(dialect)` builds a `Kysely` instance with a
`DummyDriver` — it's used purely as a compiler, never to actually connect.

- `value(expr, eb)` lowers `ValueExpr`: `column` → `eb.ref(pathToRef(path))` where
  `pathToRef = path.join('_')` (this is the *only* place owned-type flattening
  syntax — `address_city` — is assumed at the SQL layer; the normalizer already
  rewrote the IR path to match). `subaggregate` **throws** `TranslationError`
  unconditionally — see the [ormit-query-pipeline](../ormit-query-pipeline/SKILL.md)
  skill for why (no lowering pass exists yet).
- `lower(node, eb)` lowers `BoolExprNode` similarly; `exists` also throws
  unconditionally for the same reason.
- `dataType(col, isPrimaryKey)` — CLR type → Kysely DDL type token: `string`→`text`
  or `varchar(n)` if `maxLength`; `number`→`integer`; `boolean`→`integer` (no
  dialect gets a native bool column type here); `Date`→`timestamp`; `bigint`→
  `bigint`; unknown key columns default to `'integer'` (so a conventional shadow
  `id` auto-increments even with CLR type `'unknown'`) but unknown non-key columns
  default to `'text'`.
- `columnMods()` — primary keys get `.primaryKey()` + `.autoIncrement()` (if
  `isAutoIncrementType`: number/bigint/unknown) and are implicitly NOT NULL; other
  columns apply `.notNull()`/`.defaultTo()` (raw SQL default wins over a literal
  default if both are somehow set — though `finalize.ts`'s `OMT1223` already
  forbids setting both).

## Per-dialect quirks (all live in this one generator, branching on `this.dialect`)

| | sqlite | postgres | mysql | mssql |
|---|---|---|---|---|
| INSERT key return | `RETURNING *` | `RETURNING *` | none (driver reads `insertId`) | `OUTPUT INSERTED.*` |
| Paging | `LIMIT/OFFSET` | `LIMIT/OFFSET` | `LIMIT/OFFSET` | `TOP` (take-only) or `OFFSET…FETCH` (needs `ORDER BY`, auto-injected via `sql\`(select null)\`` if absent) |
| DDL in transaction | yes | yes | **no** (implicit commit) | yes |
| `ILIKE` | no (LIKE is ASCII case-insensitive) | yes | no | no |

`applyPaging()` (line ~206) is the only place MSSQL's TOP/OFFSET…FETCH branching
lives — SQL Server has no `LIMIT`. `INSERT_RETURN` map (line ~187) drives
`compileWrite`'s insert branch (`.returningAll()` / `.outputAll('inserted')` /
neither).

`compileDdl()` handles `createTable | dropTable | addColumn | dropColumn |
createIndex | dropIndex` (see [ormit-migrations](../ormit-migrations/SKILL.md) for
where these operations come from). `compileRaw()` rebuilds a
`TemplateStringsArray`-like from `fromSql()`'s captured strings/params and lets
Kysely's `sql` tag produce dialect-correct placeholders.

Every `compileX` computes its own `irHash` as a fallback
(`cmd.irHash || irHash(...)`) — `DbContext`/`Queryable` always pass a pre-computed
hash through, but the generator is defensively self-sufficient.

## Dialect executor packages (thin, structurally identical `IQueryExecutor` impls)

Each package = `KyselySqlGenerator(dialect)` (generator) + a hand-written executor
(driver-specific). None import `kysely` directly (dependency rule).

- **[dialect-sqlite](packages/dialect-sqlite/src/index.ts)** — `better-sqlite3`,
  synchronous under the hood but wrapped `async`. `toBindable()` converts
  boolean→0/1, `Date`→ISO string (better-sqlite3 only binds
  number/string/bigint/buffer/null). Detects RETURNING via a `/\breturning\b/i`
  regex on the compiled SQL to decide `.all()` vs `.run()`. Transaction =
  `BEGIN`/`COMMIT`/`ROLLBACK` via `db.exec()`. WAL journal mode set on construction.
- **[dialect-postgres](packages/dialect-postgres/src/index.ts)** — `pg` Pool.
  Transaction checks out a single `PoolClient` and holds it in `txClient` for the
  duration (nested `transaction()` calls just run inline if already in one) —
  single in-flight transaction per executor is sufficient since contexts are
  short-lived and not concurrency-safe.
- **[dialect-mysql](packages/dialect-mysql/src/index.ts)** — `mysql2/promise`.
  `execute()` synthesizes `returning: [{ id: header.insertId }]` from the driver's
  `ResultSetHeader.insertId` since MySQL has no RETURNING. Same
  hold-a-connection-during-tx pattern as postgres (`PoolConnection`).
- **[dialect-mssql](packages/dialect-mssql/src/index.ts)** — `mssql` (Tedious).
  Connection pool connects **lazily**; every request awaits `this.ready()` first
  (`this.connected` promise) before building a `Request`. Params are bound
  positionally as named inputs (`request.input(String(i+1), ...)`), matching how
  Kysely's mssql compiler names its placeholders. Transaction wraps a
  `sql.Transaction`.

All four expose `DialectCapabilities` (`returningStrategy, ddlInTransaction,
savepoints, maxParams, upsertSyntax, ilike, paging`) consumed elsewhere in the
pipeline/tooling to adapt behavior per dialect — check `IQueryExecutor.capabilities`
before assuming a feature (e.g. RETURNING) is available.
