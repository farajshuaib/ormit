import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class User {
  id!: number;
  name!: string;
  age!: number;
  active!: boolean;
}

class AppDb extends DbContext {
  users = this.set(User);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(User, (e) => {
      e.toTable('users').hasKey('id');
      e.hasQueryFilter((x) => x.active.eq(true));
    });
  }
}

let engine: SqliteEngine;
let db: AppDb;

beforeEach(async () => {
  engine = new SqliteEngine(':memory:');
  engine.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  db = new AppDb({ engine });
  db.users.addRange([
    Object.assign(new User(), { name: 'Amal', age: 30, active: true }),
    Object.assign(new User(), { name: 'Bilal', age: 17, active: true }),
    Object.assign(new User(), { name: 'Aisha', age: 25, active: true }),
    Object.assign(new User(), { name: 'Ziad', age: 41, active: false }),
  ]);
  await db.saveChanges();
});

afterEach(() => engine.close());

describe('@ormit/sqlite · real SQL execution', () => {
  it('inserts with RETURNING and writes generated keys back', async () => {
    const faraj = db.users.add(Object.assign(new User(), { name: 'faraj', age: 28, active: true }));
    const affected = await db.saveChanges();
    expect(affected).toBe(1);
    expect(faraj.id).toBeGreaterThan(0); // key round-tripped from RETURNING
  });

  it('filters, orders, and pages against SQLite', async () => {
    const adults = await db.users
      .where((x) => x.age.gt(18))
      .orderBy((x) => x.name)
      .toList();
    // Ziad (41) is excluded by the active query filter.
    expect(adults.map((u) => u.name)).toEqual(['Aisha', 'Amal']);
  });

  it('applies the global query filter (active only)', async () => {
    expect(await db.users.count()).toBe(3);
    expect(await db.users.ignoreQueryFilters().count()).toBe(4);
  });

  it('computes aggregates in the database', async () => {
    expect(await db.users.sum((x) => x.age)).toBe(72); // 30 + 17 + 25
    expect(await db.users.max((x) => x.age)).toBe(30);
    expect(await db.users.min((x) => x.age)).toBe(17);
  });

  it('supports string operators and projections', async () => {
    const names = await db.users
      .where((x) => x.name.startsWith('A'))
      .orderBy((x) => x.name)
      .select((x) => ({ n: x.name }))
      .toList();
    expect(names).toEqual([{ n: 'Aisha' }, { n: 'Amal' }]);
  });

  it('exposes SQLite dialect capabilities', () => {
    expect(engine.executor.capabilities.returningStrategy).toBe('returning');
    expect(engine.executor.capabilities.paging).toBe('limitOffset');
  });

  it('runs a parameterized fromSql query and materializes entities', async () => {
    const threshold = 20;
    const rows = await db.users
      .fromSql`SELECT * FROM users WHERE age > ${threshold} AND active = 1 ORDER BY name`
      .toList();
    expect(rows.map((u) => u.name)).toEqual(['Aisha', 'Amal']);
    expect(rows[0]).toBeInstanceOf(User);
  });

  it('rejects composing operators onto a fromSql query', () => {
    expect(() => db.users.fromSql`SELECT * FROM users`.where((x) => x.age.gt(1))).toThrow();
  });
});
