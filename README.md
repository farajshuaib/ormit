# Ormit

> An **EF Core–style ORM for TypeScript**. `DbContext`, `DbSet`, typed
> LINQ-like queries, change tracking, and migrations — for Node.js, on any SQL
> database. Kysely under the hood, never in your face.

```ts
const adults = await db.users
  .where(x => x.age.gt(18).and(x.name.startsWith('A')))
  .include(x => x.posts)
  .orderBy(x => x.name)
  .take(10)
  .toList();
```

- **Typed, safe queries** — a Proxy expression recorder (no `fn.toString()`,
  minification-safe) captures `x.age.gt(18)` into an IR. Illegal operators don't
  compile; untranslatable expressions throw at build time, never silently.
- **Change tracking & Unit of Work** — snapshot-diffing identity map, atomic
  `saveChanges()` with FK ordering, optimistic concurrency, and transactions.
- **Four dialects** — SQLite, PostgreSQL, MySQL, SQL Server, all passing the same
  behavioral compatibility suite against real servers.
- **Migrations from model snapshots** — a differ compares your model to the last
  committed snapshot (never the live DB) and emits reversible migrations.
- **Extensible** — a small plugin surface powers first-party soft-delete,
  timestamps, and multitenancy; framework adapters for Express/Fastify/NestJS.

> **Status:** 1.0-rc candidate. Packages are published under the `@ormit/*` scope.

## Install

Pick the core plus a dialect:

```bash
pnpm add @ormit/core @ormit/sqlite      # or @ormit/postgres | @ormit/mysql | @ormit/mssql
```

Requires Node.js 18+ and TypeScript 5+ (`strict` recommended).

## Quickstart

```ts
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

// 1. Plain entity classes (POCOs).
class Blog { id!: number; title!: string; posts!: Post[]; }
class Post { id!: number; title!: string; blogId!: number; blog!: Blog | null; }

// 2. A context maps entities and exposes sets.
class AppDb extends DbContext {
  blogs = this.set(Blog);
  posts = this.set(Post);
  constructor(o: DbContextOptions) { super(o); }
  protected onModelCreating(m: ModelBuilder) {
    m.entity(Blog, e => e.toTable('blogs').hasKey('id'));
    m.entity(Post, e => {
      e.toTable('posts').hasKey('id');
      e.hasOne(Blog, x => x.blog).withMany(b => b.posts).hasForeignKey('blogId');
    });
  }
}

// 3. Pick an engine and go.
const engine = new SqliteEngine(':memory:');
engine.exec(`CREATE TABLE blogs(id INTEGER PRIMARY KEY, title TEXT);
             CREATE TABLE posts(id INTEGER PRIMARY KEY, title TEXT, blogId INTEGER);`);
const db = new AppDb({ engine });

const blog = db.blogs.add(Object.assign(new Blog(), { title: 'Tech' }));
await db.saveChanges();                 // INSERT; blog.id is written back

db.posts.add(Object.assign(new Post(), { title: 'Hello', blogId: blog.id }));
await db.saveChanges();

const posts = await db.posts.include(x => x.blog).toList();
console.log(posts[0].blog?.title);      // "Tech"
```

**Using another database?** Only the engine line changes — the model, queries, and
`saveChanges()` are identical:

```ts
import { PostgresEngine } from '@ormit/postgres';
const engine = new PostgresEngine('postgres://user:pass@localhost:5432/app');

import { MysqlEngine } from '@ormit/mysql';
const engine = new MysqlEngine('mysql://user:pass@localhost:3306/app');

import { MssqlEngine } from '@ormit/mssql';
const engine = new MssqlEngine({ server: 'localhost', user: 'sa', password, database: 'app',
  options: { encrypt: false, trustServerCertificate: true } });
```

See [the guide](docs/guide.md#choosing-a-database) (or the interactive picker on the
[docs site](site/docs.html)) for each dialect's DDL.

## Querying

Every `Queryable` is immutable — each call returns a new query.

```ts
db.users
  .where(x => x.age.between(18, 65).and(x.email.isNotNull()))
  .orderBy(x => x.team).thenByDescending(x => x.createdAt)   // secondary sort keys
  .skip(20).take(10)
  .select(x => ({ id: x.id, name: x.name.toLower() }))   // projection
```

- **Operators:** `eq/neq/in/isNull/isNotNull`, `gt/gte/lt/lte/between`,
  `startsWith/endsWith/contains/like/toLower/toUpper`, and on to-many navigations
  `any(pred?)/all(pred)/count()`.
- **Ordering:** `orderBy`/`orderByDescending`, then `thenBy`/`thenByDescending` for
  secondary keys (only available after an `orderBy`, like EF's `IOrderedQueryable`).
- **Terminals:** `toList`, `first`/`firstOrNull`, `single`/`singleOrNull`,
  `count`, `any`, `sum`/`avg`/`min`/`max`, `toPage(page, size)`.
- **Loading:** `include(x => x.posts).thenInclude(p => p.comments)` (split queries
  by default), explicit `db.entry(user).collection('posts').load()`, or opt-in
  `db.lazyReference(post, 'author')`.
- **Escape hatches:** parameterized raw SQL and tracking control —

```ts
const rows = await db.users.fromSql`SELECT * FROM users WHERE name = ${name}`.toList();
const readonly = await db.users.asNoTracking().toList();
```

## Saving

```ts
const user = await db.users.find(1);        // identity-map first, then a keyed query
user!.name = 'Renamed';                     // tracked; only changed columns update
db.users.remove(other);
await db.saveChanges();                      // atomic: detect → order by FKs → commit

await db.database.transaction(async () => {  // ambient transaction across saves
  db.orders.add(order);
  await db.saveChanges();
});
```

Add `.isConcurrencyToken()` to a property (e.g. a `version`/rowversion) and a
stale update throws `ConcurrencyError`.

### Value converters

Map a rich property to a column with `hasConversion('name')` and register the
converter at runtime — applied on write, on read, and in `where` filters:

```ts
import { jsonConverter, DbContext } from '@ormit/core';

m.entity(Account, e => e.property(x => x.tags).hasConversion('json')); // string[] ⇆ JSON text
const db = new AppDb({ engine, converters: { json: jsonConverter } });
```

Built-ins: `jsonConverter`, `isoDateConverter`, `booleanNumberConverter`; author
your own (fully typed) with `defineConverter`. Only the converter *name* is stored
in the snapshot, so migrations stay byte-stable.

## Migrations

`@ormit/migrations` diffs your model snapshot and runs reversible migrations
through a history table:

```ts
import { diffWithDown, EMPTY_SNAPSHOT, snapshotData, Migrator } from '@ormit/migrations';

const { up, down } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(model));  // ModelSnapshot → ops
const migrator = new Migrator(engine, [{ id: '0001_init', up, down }]);
await migrator.up();       // idempotent — safe to run twice
await migrator.down(1);    // revert the last migration
```

`@ormit/cli` installs a real `ormit` binary over the same primitives — describe
your engine and model in an `ormit.config.ts`, then run `ormit migrations
add/list/remove/repair/has-pending-changes` and `ormit database update` directly,
the way `dotnet ef` works against an EF Core `DbContext`.

See [`examples/migration-first`](examples/migration-first) for a complete,
runnable migration-first workflow — write the model, generate the migration,
apply it, evolve the schema.

## Plugins

```ts
import { softDelete, timestamps, multitenancy } from '@ormit/plugins';

const db = new AppDb({
  engine,
  plugins: [
    softDelete(),                                   // remove() → UPDATE isDeleted + global filter
    timestamps(),                                   // stamp createdAt / updatedAt
    multitenancy({ tenant: () => currentTenantId }) // scope reads + stamp inserts
  ],
});
```

All three are built solely on the public `OrmPlugin` surface
(`configureModel`, `normalizerPasses`, lifecycle `interceptors`) — write your own
the same way.

## Dialects

| Package | Driver | Notes |
|---|---|---|
| `@ormit/sqlite` | better-sqlite3 | `RETURNING`, in-process |
| `@ormit/postgres` | pg | `RETURNING`, `ILIKE`, `LIMIT/OFFSET` |
| `@ormit/mysql` | mysql2 | `insertId` key write-back, implicit DDL commit |
| `@ormit/mssql` | mssql (tedious) | `OUTPUT INSERTED.*`, `TOP` / `OFFSET…FETCH` |

Each ships the same `DbContext` behavior — a dialect "supports" Ormit iff it
passes the compatibility suite unmodified.

## Coming from EF Core

| EF Core | Ormit |
|---|---|
| `DbContext` / `DbSet<T>` | `DbContext` / `DbSet<T>` |
| `OnModelCreating` | `onModelCreating(model)` |
| `.HasKey(x => x.Id)` | `.hasKey('id')` |
| `.Property(x => x.Name).HasMaxLength(80)` | `.property(x => x.name).hasMaxLength(80)` |
| `.HasOne(...).WithMany(...)` | `.hasOne(T, x => x.nav).withMany(...)` |
| `Where(x => x.Age > 18)` | `.where(x => x.age.gt(18))` |
| `Include(...).ThenInclude(...)` | `.include(...).thenInclude(...)` |
| `FromSqlInterpolated($"…{p}")` | `` .fromSql`…${p}` `` |
| `AsNoTracking()` | `.asNoTracking()` |
| `SaveChanges()` | `await saveChanges()` |

See the full guide: [`docs/guide.md`](docs/guide.md). Differences: everything is
async; no lazy proxies by default; collection includes are split queries
(avoids cartesian explosion).

## Packages

`@ormit/core` · `@ormit/engine-kysely` · `@ormit/sqlite` · `@ormit/postgres` ·
`@ormit/mysql` · `@ormit/mssql` · `@ormit/plugins` · `@ormit/migrations` ·
`@ormit/cli` · `@ormit/decorators` · `@ormit/adapters` · `@ormit/testing`.

## Documentation

- [Guide](docs/guide.md) — quickstart, querying, saving, EF Core mapping
- [Diagnostics](docs/diagnostics.md) — the `OMT` error catalog
- [Architecture & ADRs](docs/implementation-plan.md) · [`docs/adr/`](docs/adr)
- [Releasing](docs/releasing.md) — how to publish `@ormit/*` to npm
- [`CLAUDE.md`](CLAUDE.md) — contributor/AI technical reference

## Development

```bash
pnpm install
pnpm gate            # build + dependency rules + type tests + coverage
pnpm test:containers # PG/MySQL/MSSQL suites on real servers (needs Docker)
```

## License

[MIT](LICENSE)
