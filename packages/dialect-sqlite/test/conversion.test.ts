import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DbContext,
  booleanNumberConverter,
  isoDateConverter,
  jsonConverter,
  type DbContextOptions,
  type ModelBuilder,
} from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class Account {
  id!: number;
  name!: string;
  tags!: string[]; // stored as JSON text
  createdAt!: Date; // stored as ISO-8601 text
  premium!: boolean; // stored as 0/1
}

class AppDb extends DbContext {
  accounts = this.set(Account);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(Account, (e) => {
      e.toTable('accounts').hasKey('id');
      e.property((x) => x.tags).hasConversion('json');
      e.property((x) => x.createdAt).hasConversion('iso');
      e.property((x) => x.premium).hasConversion('bool');
    });
  }
}

const CONVERTERS = {
  json: jsonConverter,
  iso: isoDateConverter,
  bool: booleanNumberConverter,
};

let engine: SqliteEngine;
let db: AppDb;

beforeEach(async () => {
  engine = new SqliteEngine(':memory:');
  engine.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tags TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      premium INTEGER NOT NULL
    );
  `);
  db = new AppDb({ engine, converters: CONVERTERS });
});

afterEach(() => engine.close());

const seed = (over: Partial<Account> = {}) =>
  Object.assign(new Account(), {
    name: 'Acme',
    tags: ['a', 'b'],
    createdAt: new Date('2024-01-02T03:04:05.000Z'),
    premium: true,
    ...over,
  });

describe('@ormit/sqlite · value converters at runtime', () => {
  it('writes provider values and reads model values back (round-trip)', async () => {
    db.accounts.add(seed());
    await db.saveChanges();

    // Inspect the raw row: converters stored the provider representation.
    const row = engine.db
      .prepare('SELECT tags, createdAt, premium FROM accounts')
      .get() as Record<string, unknown>;
    expect(row.tags).toBe('["a","b"]');
    expect(row.createdAt).toBe('2024-01-02T03:04:05.000Z');
    expect(row.premium).toBe(1);

    // Read back through a no-tracking query: fromProvider rebuilds model values.
    const [acc] = await db.accounts.asNoTracking().toList();
    expect(acc!.tags).toEqual(['a', 'b']);
    expect(acc!.createdAt).toBeInstanceOf(Date);
    expect(acc!.createdAt.toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(acc!.premium).toBe(true);
  });

  it('applies toProvider to filter constants over a converted column', async () => {
    db.accounts.addRange([seed({ name: 'yes', premium: true }), seed({ name: 'no', premium: false })]);
    await db.saveChanges();

    const premium = await db.accounts
      .asNoTracking()
      .where((x) => x.premium.eq(true))
      .toList();
    expect(premium.map((a) => a.name)).toEqual(['yes']);
  });

  it('applies toProvider to IN-list values over a converted column', async () => {
    db.accounts.addRange([
      seed({ name: 'on', premium: true }),
      seed({ name: 'off', premium: false }),
    ]);
    await db.saveChanges();

    const rows = await db.accounts
      .asNoTracking()
      .where((x) => x.premium.in([true]))
      .toList();
    expect(rows.map((a) => a.name)).toEqual(['on']);
  });

  it('converts changed columns on update', async () => {
    const acc = db.accounts.add(seed({ premium: true }));
    await db.saveChanges();
    acc.premium = false;
    acc.tags = ['x'];
    await db.saveChanges();

    const row = engine.db
      .prepare('SELECT tags, premium FROM accounts WHERE id = ?')
      .get(acc.id) as Record<string, unknown>;
    expect(row.premium).toBe(0);
    expect(row.tags).toBe('["x"]');
  });

  it('rejects a model referencing an unregistered converter', () => {
    expect(() => new AppDb({ engine })).toThrow(/uses converter/);
  });
});
