/**
 * MySQL compatibility suite (plan §5/§7) against a real server via
 * Testcontainers. Gated behind ORMIT_TESTCONTAINERS; run with:
 *
 *   ORMIT_TESTCONTAINERS=1 pnpm vitest run packages/dialect-mysql
 *
 * MySQL has no RETURNING (the executor uses insertId) and implicitly commits
 * DDL — both exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import {
  ConcurrencyError,
  DbContext,
  type DbContextOptions,
  type ModelBuilder,
} from '@ormit/core';
import { MysqlEngine } from '@ormit/mysql';

class User {
  id!: number;
  name!: string;
  age!: number;
  active!: boolean;
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
      e.hasQueryFilter((x) => x.active.eq(true));
    });
  }
}

const RUN = Boolean(process.env['ORMIT_TESTCONTAINERS']);

describe.runIf(RUN)('@ormit/mysql · compatibility suite', () => {
  let container: StartedMySqlContainer;
  let engine: MysqlEngine;

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8').start();
    engine = new MysqlEngine(container.getConnectionUri());
    await engine.exec(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        age INT NOT NULL,
        active TINYINT NOT NULL DEFAULT 1,
        version INT NOT NULL DEFAULT 1
      );
    `);
  }, 240_000);

  afterAll(async () => {
    await engine?.close();
    await container?.stop();
  });

  it('inserts and writes the key back via insertId (no RETURNING)', async () => {
    const db = new AppDb({ engine });
    const u = db.users.add(Object.assign(new User(), { name: 'Amal', age: 30, active: true, version: 1 }));
    expect(await db.saveChanges()).toBe(1);
    expect(Number(u.id)).toBeGreaterThan(0);
  });

  it('filters with the global query filter and aggregates', async () => {
    const db = new AppDb({ engine });
    db.users.addRange([
      Object.assign(new User(), { name: 'Bilal', age: 17, active: true, version: 1 }),
      Object.assign(new User(), { name: 'Hidden', age: 99, active: false, version: 1 }),
    ]);
    await db.saveChanges();

    const q = new AppDb({ engine });
    const rows = await q.users.orderBy((x) => x.name).toList();
    expect(rows.some((u) => u.name === 'Hidden')).toBe(false); // filtered out
    expect(await q.users.ignoreQueryFilters().count()).toBeGreaterThanOrEqual(3);
    expect(Number(await q.users.sum((x) => x.age))).toBeGreaterThan(0);
  });

  it('updates and deletes', async () => {
    const db = new AppDb({ engine });
    const user = await db.users.orderBy((x) => x.id).first();
    user.age += 1;
    expect(await db.saveChanges()).toBe(1);
    db.users.remove(user);
    expect(await db.saveChanges()).toBe(1);
  });

  it('raises ConcurrencyError on a stale optimistic update', async () => {
    const seed = new AppDb({ engine });
    const created = seed.users.add(
      Object.assign(new User(), { name: 'Race', age: 40, active: true, version: 1 }),
    );
    await seed.saveChanges();

    const ctxA = new AppDb({ engine });
    const ctxB = new AppDb({ engine });
    const a = await ctxA.users.where((x) => x.id.eq(created.id)).first();
    const b = await ctxB.users.where((x) => x.id.eq(created.id)).first();

    a.age = 41;
    a.version = 2;
    await ctxA.saveChanges();

    b.age = 99;
    await expect(ctxB.saveChanges()).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it('rolls back a failed transaction', async () => {
    const db = new AppDb({ engine });
    await expect(
      db.database.transaction(async () => {
        db.users.add(Object.assign(new User(), { name: 'Txn', age: 1, active: true, version: 1 }));
        await db.saveChanges();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const survived = await new AppDb({ engine })
      .users.ignoreQueryFilters()
      .where((x) => x.name.eq('Txn'))
      .count();
    expect(survived).toBe(0);
  });
});
