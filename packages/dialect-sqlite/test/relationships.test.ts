/**
 * Phase 6 gate: the blog example runs end-to-end (relationships + eager,
 * explicit, and N+1-detected loading) against real SQLite.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder, type OrmWarning } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class User {
  id!: number;
  name!: string;
  posts!: Post[];
}
class Blog {
  id!: number;
  title!: string;
  posts!: Post[];
}
class Post {
  id!: number;
  title!: string;
  blogId!: number;
  authorId!: number;
  author!: User | null;
  blog!: Blog | null;
  comments!: Comment[];
}
class Comment {
  id!: number;
  text!: string;
  postId!: number;
}

class BlogDb extends DbContext {
  users = this.set(User);
  blogs = this.set(Blog);
  posts = this.set(Post);
  comments = this.set(Comment);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(User, (e) => e.toTable('users').hasKey('id'));
    model.entity(Blog, (e) => e.toTable('blogs').hasKey('id'));
    model.entity(Comment, (e) => e.toTable('comments').hasKey('id'));
    model.entity(Post, (e) => {
      e.toTable('posts').hasKey('id');
      e.hasOne(User, (x) => x.author).withMany((u) => u.posts).hasForeignKey('authorId');
      e.hasOne(Blog, (x) => x.blog).withMany((b) => b.posts).hasForeignKey('blogId');
      e.hasMany(Comment, (x) => x.comments).withOne().hasForeignKey('postId');
    });
  }
}

function schema(engine: SqliteEngine): void {
  engine.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE blogs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      blogId INTEGER NOT NULL, authorId INTEGER NOT NULL
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, postId INTEGER NOT NULL
    );
  `);
}

async function seed(engine: SqliteEngine): Promise<void> {
  const db = new BlogDb({ engine });
  const alice = db.users.add(Object.assign(new User(), { name: 'Alice' }));
  const bob = db.users.add(Object.assign(new User(), { name: 'Bob' }));
  const blog = db.blogs.add(Object.assign(new Blog(), { title: 'Tech' }));
  await db.saveChanges();

  const p1 = db.posts.add(Object.assign(new Post(), { title: 'Hello', blogId: blog.id, authorId: alice.id }));
  const p2 = db.posts.add(Object.assign(new Post(), { title: 'World', blogId: blog.id, authorId: bob.id }));
  await db.saveChanges();

  db.comments.addRange([
    Object.assign(new Comment(), { text: 'nice', postId: p1.id }),
    Object.assign(new Comment(), { text: 'great', postId: p1.id }),
    Object.assign(new Comment(), { text: 'ok', postId: p2.id }),
  ]);
  await db.saveChanges();
}

let engine: SqliteEngine;
beforeEach(async () => {
  engine = new SqliteEngine(':memory:');
  schema(engine);
  await seed(engine);
});

describe('eager loading · Include', () => {
  it('loads a to-one reference (post.author)', async () => {
    const db = new BlogDb({ engine });
    const posts = await db.posts.include((p) => p.author).orderBy((p) => p.id).toList();
    expect(posts.map((p) => p.author?.name)).toEqual(['Alice', 'Bob']);
  });

  it('loads a collection (blog.posts) as a split query', async () => {
    const db = new BlogDb({ engine });
    const blog = await db.blogs.include((b) => b.posts).first();
    expect(blog.posts.map((p) => p.title).sort()).toEqual(['Hello', 'World']);
  });

  it('ThenInclude chains through a collection (blog → posts → comments)', async () => {
    const db = new BlogDb({ engine });
    const blog = await db.blogs
      .include((b) => b.posts)
      .thenInclude((p: Post) => p.comments)
      .first();
    const hello = blog.posts.find((p) => p.title === 'Hello')!;
    expect(hello.comments.map((c) => c.text).sort()).toEqual(['nice', 'great'].sort());
  });

  it('supports multiple includes on one query', async () => {
    const db = new BlogDb({ engine });
    const post = await db.posts.include((p) => p.author).include((p) => p.comments).first();
    expect(post.author?.name).toBe('Alice');
    expect(post.comments.length).toBe(2);
  });
});

describe('explicit loading', () => {
  it('loads a reference on demand via entry().reference().load()', async () => {
    const db = new BlogDb({ engine });
    const post = await db.posts.orderBy((p) => p.id).first();
    expect(post.author).toBeUndefined();
    await db.entry(post).reference('author').load();
    expect(post.author?.name).toBe('Alice');
  });

  it('loads a collection on demand via entry().collection().load()', async () => {
    const db = new BlogDb({ engine });
    const blog = await db.blogs.first();
    await db.entry(blog).collection('posts').load();
    expect(blog.posts.length).toBe(2);
  });
});

describe('lazy loading (ADR-004)', () => {
  it('LazyRef resolves a reference on await .load()', async () => {
    const db = new BlogDb({ engine });
    const post = await db.posts.orderBy((p) => p.id).first();
    const authorRef = db.lazyReference<User>(post, 'author');
    expect(authorRef.loaded).toBe(false);
    const author = await authorRef.load();
    expect(author?.name).toBe('Alice');
    expect(authorRef.loaded).toBe(true);
  });

  it('LazyCollection resolves a collection on await .load()', async () => {
    const db = new BlogDb({ engine });
    const blog = await db.blogs.first();
    const posts = db.lazyCollection<Post>(blog, 'posts');
    expect((await posts.load()).length).toBe(2);
  });
});

describe('cascade delete', () => {
  it('deletes dependent rows when the principal is removed (cascade)', async () => {
    const db = new BlogDb({ engine });
    const blog = await db.blogs.first();
    db.blogs.remove(blog);
    await db.saveChanges();
    // The blog's posts cascade-deleted.
    expect(await new BlogDb({ engine }).posts.count()).toBe(0);
  });
});

describe('N+1 detector (diagnostics mode)', () => {
  it('flags many individual reference loads of the same entity', async () => {
    // Seed enough posts to cross the threshold.
    const setup = new BlogDb({ engine });
    for (let i = 0; i < 15; i++) {
      setup.posts.add(Object.assign(new Post(), { title: `p${i}`, blogId: 1, authorId: 1 }));
    }
    await setup.saveChanges();

    const warnings: OrmWarning[] = [];
    const db = new BlogDb({ engine, diagnostics: true, onWarning: (w) => warnings.push(w) });
    const posts = await db.posts.toList();
    // The anti-pattern: load each post's author one at a time.
    for (const post of posts) await db.entry(post).reference('author').load();

    expect(warnings.some((w) => w.code === 'OMT2001')).toBe(true);
  });

  it('does not flag a batched Include', async () => {
    const warnings: OrmWarning[] = [];
    const db = new BlogDb({ engine, diagnostics: true, onWarning: (w) => warnings.push(w) });
    await db.posts.include((p) => p.author).toList();
    expect(warnings).toHaveLength(0);
  });
});
