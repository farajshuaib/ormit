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

## Querying

- **Filter/shape:** `where`, `orderBy(Descending)`, `skip`, `take`, `distinct`,
  `select(x => ({ … }))`.
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

## Migrations

```bash
ormit migrations add "init"     # diff model vs committed snapshot → migration + snapshot
ormit database update           # apply pending (idempotent)
ormit database update --down 1  # revert the last migration
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
