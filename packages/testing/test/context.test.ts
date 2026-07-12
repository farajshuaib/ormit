import { describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { InMemoryEngine } from '@ormit/testing';

class User {
  id!: number;
  name!: string;
  age!: number;
}

class AppDb extends DbContext {
  users = this.set(User);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(User, (e) => e.toTable('users').hasKey('id'));
  }
}

function makeDb() {
  const engine = new InMemoryEngine();
  engine.seed('users', [
    { id: 1, name: 'Amal', age: 30 },
    { id: 2, name: 'Bilal', age: 17 },
    { id: 3, name: 'Aisha', age: 25 },
    { id: 4, name: 'Ziad', age: 41 },
  ]);
  return { engine, db: new AppDb({ engine }) };
}

describe('DbContext + Queryable over in-memory engine', () => {
  it('filters, orders, and pages — EF style', async () => {
    const { db } = makeDb();
    const adults = await db.users
      .where((x) => x.age.gt(18))
      .orderBy((x) => x.name)
      .take(2)
      .toList();
    expect(adults.map((u) => u.name)).toEqual(['Aisha', 'Amal']);
    expect(adults[0]).toBeInstanceOf(User);
  });

  it('queryables are immutable — forks do not contaminate the set', async () => {
    const { db } = makeDb();
    const filtered = db.users.where((x) => x.age.gt(100));
    expect(await filtered.count()).toBe(0);
    expect(await db.users.count()).toBe(4); // base set untouched
  });

  it('count/any/first terminals', async () => {
    const { db } = makeDb();
    expect(await db.users.where((x) => x.name.startsWith('A')).count()).toBe(2);
    expect(await db.users.where((x) => x.age.lt(10)).any()).toBe(false);
    const teen = await db.users.where((x) => x.age.lt(18)).first();
    expect(teen.name).toBe('Bilal');
  });

  it('toPage returns items + total', async () => {
    const { db } = makeDb();
    const page = await db.users.orderBy((x) => x.id).toPage(2, 3);
    expect(page.total).toBe(4);
    expect(page.items.map((u) => u.id)).toEqual([4]);
  });

  it('saveChanges inserts and writes generated keys back', async () => {
    const { db, engine } = makeDb();
    const u = db.users.add(Object.assign(new User(), { name: 'faraj', age: 28 }));
    const affected = await db.saveChanges();
    expect(affected).toBe(1);
    expect(u.id).toBe(5); // key write-back
    expect(engine.rows('users')).toHaveLength(5);
    expect(await db.saveChanges()).toBe(0); // pending queue drained
  });
});
