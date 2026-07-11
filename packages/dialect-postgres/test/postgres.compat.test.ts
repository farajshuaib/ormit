/**
 * PostgreSQL compatibility suite (plan §5/§7) against a real server via
 * Testcontainers. Gated behind ORMIT_TESTCONTAINERS so the default `pnpm gate`
 * stays offline; run with:
 *
 *   ORMIT_TESTCONTAINERS=1 pnpm vitest run packages/dialect-postgres
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ConcurrencyError,
  DbContext,
  type DbContextOptions,
  type ModelBuilder,
} from '@ormit/core';
import { PostgresEngine } from '@ormit/postgres';

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

describe.runIf(RUN)('@ormit/postgres · compatibility suite', () => {
  let container: StartedPostgreSqlContainer;
  let engine: PostgresEngine;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    engine = new PostgresEngine(container.getConnectionUri());
    await engine.exec(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        version INTEGER NOT NULL DEFAULT 1
      );
    `);
  }, 180_000);

  afterAll(async () => {
    await engine?.close();
    await container?.stop();
  });

  it('inserts with RETURNING and writes the key back', async () => {
    const db = new AppDb({ engine });
    const u = db.users.add(Object.assign(new User(), { name: 'Amal', age: 30, active: true, version: 1 }));
    expect(await db.saveChanges()).toBe(1);
    expect(u.id).toBeGreaterThan(0);
  });

  it('filters (with the global query filter), orders, aggregates', async () => {
    const db = new AppDb({ engine });
    db.users.addRange([
      Object.assign(new User(), { name: 'Bilal', age: 17, active: true, version: 1 }),
      Object.assign(new User(), { name: 'Hidden', age: 99, active: false, version: 1 }),
    ]);
    await db.saveChanges();

    const q = new AppDb({ engine });
    const adults = await q.users.where((x) => x.age.gt(18)).orderBy((x) => x.name).toList();
    expect(adults.every((u) => u.active)).toBe(true);
    expect(await q.users.ignoreQueryFilters().count()).toBeGreaterThanOrEqual(3);
    expect(await q.users.sum((x) => x.age)).toBeGreaterThan(0);
  });

  it('updates only changed columns and deletes', async () => {
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

    // Two contexts load the same row (version 1).
    const ctxA = new AppDb({ engine });
    const ctxB = new AppDb({ engine });
    const a = await ctxA.users.where((x) => x.id.eq(created.id)).first();
    const b = await ctxB.users.where((x) => x.id.eq(created.id)).first();

    a.age = 41;
    a.version = 2; // A wins, bumps the token
    await ctxA.saveChanges();

    b.age = 99; // B still holds version 1 → matches zero rows
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
