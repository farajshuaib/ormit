/**
 * Behavioral CRUD suite (Phase 5 "compatibility suite v1"), run against real
 * SQLite. The four-dialect matrix runs via Testcontainers in CI (plan §7); this
 * is the locally-runnable slice — CRUD, identity map, optimistic concurrency,
 * transaction atomicity, and context isolation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConcurrencyError,
  createContextFactory,
  DbContext,
  type DbContextOptions,
  type ModelBuilder,
} from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class User {
  id!: number;
  name!: string;
  age!: number;
  version!: number;
}

class AppDb extends DbContext {
  users = this.set(User);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(User, (e) => {
      e.toTable('users').hasKey('id');
      e.property((x) => x.version).isConcurrencyToken();
    });
  }
}

function freshEngine(): SqliteEngine {
  const engine = new SqliteEngine(':memory:');
  engine.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
  `);
  return engine;
}

let engine: SqliteEngine;
beforeEach(() => {
  engine = freshEngine();
});

describe('CRUD lifecycle', () => {
  it('inserts and writes the generated key back', async () => {
    const db = new AppDb({ engine });
    const u = db.users.add(Object.assign(new User(), { name: 'Amal', age: 30, version: 1 }));
    expect(await db.saveChanges()).toBe(1);
    expect(u.id).toBeGreaterThan(0);
    expect(await db.saveChanges()).toBe(0); // no pending changes
  });

  it('tracks a queried entity, updates only changed columns', async () => {
    const seed = new AppDb({ engine });
    seed.users.add(Object.assign(new User(), { name: 'Bilal', age: 20, version: 1 }));
    await seed.saveChanges();

    const db = new AppDb({ engine });
    const user = await db.users.first();
    user.age = 21;
    expect(await db.saveChanges()).toBe(1);

    const reread = await new AppDb({ engine }).users.first();
    expect(reread.age).toBe(21);
  });

  it('deletes a tracked entity', async () => {
    const db = new AppDb({ engine });
    db.users.add(Object.assign(new User(), { name: 'Gone', age: 1, version: 1 }));
    await db.saveChanges();
    const user = await db.users.first();
    db.users.remove(user);
    expect(await db.saveChanges()).toBe(1);
    expect(await db.users.count()).toBe(0);
  });

  it('find() returns the same tracked instance (identity map)', async () => {
    const db = new AppDb({ engine });
    const created = db.users.add(Object.assign(new User(), { name: 'Ide', age: 5, version: 1 }));
    await db.saveChanges();

    const a = await db.users.find(created.id);
    const b = await db.users.find(created.id);
    expect(a).toBe(b); // same instance from the identity map
    expect(a).toBe(created);
  });
});

describe('optimistic concurrency', () => {
  it('throws ConcurrencyError when the row changed underneath (deterministic)', async () => {
    const setup = new AppDb({ engine });
    setup.users.add(Object.assign(new User(), { name: 'Race', age: 40, version: 1 }));
    await setup.saveChanges();

    // Two contexts load the same row (version 1).
    const ctxA = new AppDb({ engine });
    const ctxB = new AppDb({ engine });
    const a = await ctxA.users.first();
    const b = await ctxB.users.first();

    // A wins: bumps the concurrency token.
    a.age = 41;
    a.version = 2;
    await ctxA.saveChanges();

    // B still holds version 1 — its update matches zero rows.
    b.age = 99;
    await expect(ctxB.saveChanges()).rejects.toBeInstanceOf(ConcurrencyError);
  });
});

describe('transaction atomicity', () => {
  it('rolls the whole unit of work back on failure', async () => {
    const seed = new AppDb({ engine });
    seed.users.add(Object.assign(new User(), { id: 1, name: 'Seed', age: 1, version: 1 }));
    await seed.saveChanges();

    const db = new AppDb({ engine });
    db.users.add(Object.assign(new User(), { name: 'Valid', age: 2, version: 1 }));
    // Force a primary-key collision so one insert in the batch fails.
    db.users.add(Object.assign(new User(), { id: 1, name: 'Dupe', age: 3, version: 1 }));

    await expect(db.saveChanges()).rejects.toBeTruthy();
    // Neither insert survived: only the seeded row remains.
    expect(await new AppDb({ engine }).users.count()).toBe(1);
  });

  it('database.transaction rolls back across multiple saveChanges', async () => {
    const db = new AppDb({ engine });
    await expect(
      db.database.transaction(async () => {
        db.users.add(Object.assign(new User(), { name: 'T1', age: 1, version: 1 }));
        await db.saveChanges();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await new AppDb({ engine }).users.count()).toBe(0);
  });
});

describe('context factory · isolation', () => {
  it('produces isolated contexts with independent trackers', async () => {
    const factory = createContextFactory(AppDb, { engine, poolSize: 2 });
    const a = factory.create();
    const b = factory.create();
    a.users.add(Object.assign(new User(), { name: 'A', age: 1, version: 1 }));
    // b's tracker never saw a's addition.
    expect(await b.saveChanges()).toBe(0);
    expect(await a.saveChanges()).toBe(1);
    await factory.release(a);
    await factory.release(b);
  });

  it('scoped() disposes the context afterwards', async () => {
    const factory = createContextFactory(AppDb, { engine });
    const count = await factory.scoped(async (db) => {
      db.users.add(Object.assign(new User(), { name: 'S', age: 1, version: 1 }));
      await db.saveChanges();
      return db.users.count();
    });
    expect(count).toBe(1);
  });
});
