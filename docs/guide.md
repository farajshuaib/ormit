# Ormit guide

A quick tour of the consumer surface. See `docs/implementation-plan.md` for the
full architecture and `docs/diagnostics.md` for the error catalog.

## Quickstart (SQLite)

```ts
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class Blog { id!: number; title!: string; posts!: Post[]; }
class Post { id!: number; title!: string; blogId!: number; blog!: Blog | null; }

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

const engine = new SqliteEngine(':memory:');
engine.exec(`CREATE TABLE blogs(id INTEGER PRIMARY KEY, title TEXT);
             CREATE TABLE posts(id INTEGER PRIMARY KEY, title TEXT, blogId INTEGER);`);
const db = new AppDb({ engine });

const blog = db.blogs.add(Object.assign(new Blog(), { title: 'Tech' }));
await db.saveChanges();                       // INSERT + generated key write-back

const recent = await db.posts
  .where(x => x.title.startsWith('A'))
  .include(x => x.blog)                        // split-query eager load
  .orderBy(x => x.id)
  .take(10)
  .toList();
```

## Choosing a database

Only the **engine import + construction** and your **DDL dialect** change between
databases — the `DbContext`, model, queries, and `saveChanges()` are identical.
Ormit adapts the SQL (`RETURNING` vs `OUTPUT` vs `insertId`, `LIMIT/OFFSET` vs
`TOP` / `OFFSET…FETCH`) for you.

```bash
pnpm add @ormit/core @ormit/sqlite     # or @ormit/postgres | @ormit/mysql | @ormit/mssql
```

**SQLite** (`@ormit/sqlite`, better-sqlite3 — synchronous, in-process):

```ts
import { SqliteEngine } from '@ormit/sqlite';
const engine = new SqliteEngine('app.db');            // or ':memory:'
engine.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER NOT NULL)`);
```

**PostgreSQL** (`@ormit/postgres`, node-postgres):

```ts
import { PostgresEngine } from '@ormit/postgres';
const engine = new PostgresEngine('postgres://user:pass@localhost:5432/app'); // string or PoolConfig
await engine.exec(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL)`);
```

**MySQL** (`@ormit/mysql`, mysql2):

```ts
import { MysqlEngine } from '@ormit/mysql';
const engine = new MysqlEngine('mysql://user:pass@localhost:3306/app');
await engine.exec(`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, age INT NOT NULL)`);
```

**SQL Server** (`@ormit/mssql`, node-mssql):

```ts
import { MssqlEngine } from '@ormit/mssql';
const engine = new MssqlEngine({
  server: 'localhost', user: 'sa', password: process.env.MSSQL_PASSWORD!, database: 'app',
  options: { encrypt: false, trustServerCertificate: true },
});
await engine.exec(`CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(255) NOT NULL, age INT NOT NULL)`);
```

Then `const db = new AppDb({ engine })` — the rest of your code is portable.

## Defining a model

Entities are POCOs; configure them fluently in `onModelCreating` (precedence
`convention < decorator < fluent`).

```ts
m.entity(Post, e => {
  e.toTable('posts', 'blog').hasKey('id');          // table + schema; composite: hasKey('a','b')
  e.property(x => x.title).hasMaxLength(200).isRequired();
  e.property(x => x.createdAt).hasDefaultSql('now()').valueGenerated('onAdd');
  e.property(x => x.version).isConcurrencyToken();
  e.hasIndex('slug').isUnique();
  e.hasQueryFilter(x => x.deleted.eq(false));        // applied to every read
  e.hasData({ id: 1, title: 'Seed' });               // seed row for migrations

  // Relationships (1:1, 1:N, N:M) + delete behavior.
  e.hasOne(User, x => x.author).withMany(u => u.posts).hasForeignKey('authorId').onDelete('cascade');
  e.ownsOne(Address, x => x.address);                // value object flattened into the table
});

// TPH inheritance — one table, a discriminator per subtype.
m.entity(Dog, e => e.toTable('animals').hasKey('id').hasDiscriminator('kind', 'dog'));
m.entity(Cat, e => e.toTable('animals').hasKey('id').hasDiscriminator('kind', 'cat'));
```

Property options: `hasColumnName`, `hasType`, `hasMaxLength`, `isRequired`,
`hasDefault`, `hasDefaultSql`, `valueGenerated`, `isConcurrencyToken`,
`hasComment`. Prefer decorators? `@ormit/decorators` (`@entity/@key/@column/
@hasOne/@hasMany`) replays into the same builder via `applyDecorators(m, [...])`.

### Value converters

`hasConversion('name')` maps a property to a column through a named converter —
`toProvider` on write and in `where` filters, `fromProvider` on read. Only the
name lives in the snapshot (migrations stay byte-stable); the functions are
supplied at runtime through `DbContextOptions.converters`:

```ts
import { jsonConverter, isoDateConverter, booleanNumberConverter, defineConverter } from '@ormit/core';

m.entity(Account, e => {
  e.property(x => x.tags).hasConversion('json');      // string[] ⇆ JSON text
  e.property(x => x.createdAt).hasConversion('iso');  // Date     ⇆ ISO-8601 text
  e.property(x => x.premium).hasConversion('bool');   // boolean  ⇆ 0/1
});

const db = new AppDb({
  engine,
  converters: {
    json: jsonConverter, iso: isoDateConverter, bool: booleanNumberConverter,
    // custom, fully typed on both sides:
    role: defineConverter<Role, number>({ toProvider: r => r.valueOf(), fromProvider: n => n as Role }),
  },
});
```

`null` passes through untouched; a property naming an unregistered converter
throws at context construction. The stored type is the *provider* type — model
the column accordingly.

## Querying

- **Filter/shape:** `where`, `orderBy(Descending)` then `thenBy(Descending)` for
  secondary keys, `skip`, `take`, `distinct`, `select(x => ({ … }))`.
- **Operators:** `eq/neq/in/isNull`, `gt/gte/lt/lte/between`, `startsWith/
  endsWith/contains/like/toLower/toUpper`, and to-many `any/all/count`.
- **Terminals:** `toList/first(OrNull)/single(OrNull)/count/any/sum/avg/min/max/
  toPage`.
- **Escape hatches:** `` fromSql`…${param}` `` (parameterized), `asNoTracking()`,
  `ignoreQueryFilters()`.

## Saving

`add/attach/remove/find`, then `saveChanges()` — change detection, FK topo-sort,
atomic transaction, generated-key write-back, optimistic concurrency
(`ConcurrencyError`). `database.transaction(fn)` gives ambient transactions.
Inspect tracking with `db.entry(entity)` (`state`, `modifiedProperties()`).

Contexts are per-request and not concurrency-safe — pool them:

```ts
import { createContextFactory } from '@ormit/core';
const factory = createContextFactory(AppDb, { engine, poolSize: 8 });
await factory.scoped(async (db) => { db.users.add(user); await db.saveChanges(); });
```

## Relationships & loading

```ts
// Eager — split queries by default (no cartesian explosion).
const blogs = await db.blogs.include(x => x.posts).thenInclude(p => p.comments).toList();

// Explicit — on demand.
await db.entry(post).reference('author').load();
await db.entry(blog).collection('posts').load();

// Lazy — opt-in, always awaited.
const author = await db.lazyReference<User>(post, 'author').load();
```

Cascade delete / `setNull` honored on `saveChanges()`. In diagnostics mode
(`new AppDb({ engine, diagnostics: true, onWarning })`) an N+1 detector flags
repeated single-entity loads (`OMT2001`).

## Plugins

```ts
import { softDelete, timestamps, multitenancy } from '@ormit/plugins';
const db = new AppDb({ engine, plugins: [softDelete(), timestamps(), multitenancy({ tenant })] });
```

Write your own on the `OrmPlugin` surface — `configureModel`, `normalizerPasses`,
and interceptors (`savingChanges`/`savedChanges`/`commandExecuting`/`commandExecuted`):

```ts
const audit: OrmPlugin = {
  name: 'audit',
  interceptors: {
    savingChanges(ctx) {
      for (const e of ctx.entries)
        if (e.state === 'Added' || e.state === 'Modified') (e.entity as any).updatedBy = user();
    },
  },
};
```

## Web adapters

`@ormit/adapters` creates a pooled context per request and disposes it at the end:

```ts
import { createOrmitFactory, ormitExpress, ormitFastify, ormitNestProviders } from '@ormit/adapters';

const factory = createOrmitFactory(AppDb, { engine, poolSize: 8 });
app.use(ormitExpress(factory));                       // Express → req.db
fastify.register(ormitFastify(factory));              // Fastify → request.db
// NestJS: providers: ormitNestProviders(AppDb, { engine })  // REQUEST-scoped AppDb
```

## Testing

`@ormit/testing` ships an in-memory engine with real query semantics — no DB, no Docker:

```ts
import { InMemoryEngine } from '@ormit/testing';

const engine = new InMemoryEngine();
engine.seed('users', [{ id: 1, name: 'Amal', age: 30 }]);
const db = new AppDb({ engine });
expect(await db.users.where(x => x.age.gte(18)).count()).toBe(1);
```

## Migrations

Migrations come from diffing your model snapshot against the last *committed* one
(never the live DB, ADR-006). Share one model definition between the context and
the tooling, then diff → emit → run.

```ts
import { ModelBuilder, ModelSnapshot } from '@ormit/core';

export function defineModel(m: ModelBuilder) {
  m.entity(User, e => e.toTable('users').hasKey('id'));
  m.entity(Post, e => {
    e.toTable('posts').hasKey('id');
    e.hasOne(User, x => x.author).withMany(u => u.posts).hasForeignKey('authorId');
  });
}

class AppDb extends DbContext {
  protected onModelCreating(m: ModelBuilder) { defineModel(m); }
}

const mb = new ModelBuilder();
defineModel(mb);
const model = ModelSnapshot.build(mb);   // immutable, byte-stable snapshot
```

**Diff & apply** — the runner tracks state in an `__ormit_migrations` table:

```ts
import { diffWithDown, EMPTY_SNAPSHOT, snapshotData, Migrator } from '@ormit/migrations';

const { up, down } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(model));  // first migration
const migrator = new Migrator(engine, [{ id: '0001_init', up, down }]);

await migrator.up();                    // apply pending — idempotent, safe to run twice
console.log(await migrator.applied());  // ['0001_init']
await migrator.down(1);                 // revert the last migration
```

**Evolving the schema** — diff the committed snapshot against the current model
(each change gets an automatic inverse), then emit a hand-mergeable TS file:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { deserializeSnapshot } from '@ormit/core';
import { diffWithDown, emitMigration, repairSnapshot } from '@ormit/migrations';

const committed = deserializeSnapshot(readFileSync('model.snapshot.json', 'utf8'));
const { up, down } = diffWithDown(committed, snapshotData(model));
// up: [{ kind: 'addColumn', table: 'users', column: { name: 'age', … } }]

const { filename, source } = emitMigration('add age', up, down);
writeFileSync(`migrations/${filename}`, source);       // 20260101120000_add_age.ts
writeFileSync('model.snapshot.json', model.toJSON());  // commit the new snapshot

// After a merge conflict in the snapshot, re-derive the canonical form:
const { snapshot, changed } = repairSnapshot(model, readFileSync('model.snapshot.json', 'utf8'));
if (changed) writeFileSync('model.snapshot.json', snapshot);
```

See [`examples/migration-first`](../examples/migration-first) for this whole
workflow wired up and runnable end to end against SQLite, including the CLI
commands (`migrations:add`, `db:update`, `db:script`, `migrations:repair`) and a
second migration that adds a column to prove schema evolution preserves data.

## CLI

`@ormit/cli` is the injectable core behind the `ormit` command — pass your engine,
model, committed snapshot, and known migrations, then call the verbs:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCli } from '@ormit/cli';

const cli = createCli({
  engine,
  model,                                   // ModelSnapshot (built above)
  committedSnapshot: existsSync('model.snapshot.json')
    ? readFileSync('model.snapshot.json', 'utf8') : undefined,
  migrations,                              // Migration[] emitted so far
});

const { migration, snapshot, destructive } = cli.add('init');  // diff → migration + snapshot
writeFileSync(`migrations/${migration.filename}`, migration.source);
writeFileSync('model.snapshot.json', snapshot);

await cli.update();                        // apply pending → ['0001_init']
await cli.revert(1);                       // roll back the last
const { applied, pending } = await cli.list();
const sql = cli.script();                  // forward DDL as text
cli.repair();                              // re-derive the snapshot
```

A thin binary wraps these into terminal verbs:

```bash
ormit migrations add "init"     # diff model vs committed snapshot → migration + snapshot
ormit migrations list           # applied vs. pending
ormit database update           # apply pending (idempotent)
ormit database update --down 1  # revert the last migration
ormit script                    # print the forward DDL
ormit migrations repair         # re-derive the snapshot after a merge conflict
```

## Coming from EF Core

| EF Core | Ormit |
|---|---|
| `DbContext` / `DbSet<T>` | `DbContext` / `DbSet<T>` |
| `OnModelCreating(ModelBuilder)` | `onModelCreating(model: ModelBuilder)` |
| `modelBuilder.Entity<T>()` | `model.entity(T, e => …)` |
| `.HasKey(x => x.Id)` | `.hasKey('id')` (composite: `hasKey('a','b')`) |
| `.Property(x => x.Name).HasMaxLength(80)` | `.property(x => x.name).hasMaxLength(80)` |
| `.HasOne(...).WithMany(...)` | `.hasOne(T, x => x.nav).withMany(...)` |
| `.OwnsOne(...)` | `.ownsOne(T, x => x.addr, a => …)` |
| `Where(x => x.Age > 18)` | `.where(x => x.age.gt(18))` |
| `Include(x => x.Posts).ThenInclude(...)` | `.include(x => x.posts).thenInclude(...)` |
| `FromSqlInterpolated($"…{p}")` | `` .fromSql`…${p}` `` |
| `AsNoTracking()` | `.asNoTracking()` |
| `SaveChanges()` | `saveChanges()` (async) |
| `Database.BeginTransaction()` | `database.transaction(fn)` |
| `[Timestamp]` / rowversion | `.isConcurrencyToken()` |
| Migrations (`dotnet ef`) | `ormit` CLI + `@ormit/migrations` |

Key differences: everything async (`await`); no lazy proxies by default — use
`include`, explicit `entry().reference/collection().load()`, or opt-in
`LazyRef`/`LazyCollection`; collection includes are **split queries** by default
(ADR-003) to avoid cartesian explosion.
