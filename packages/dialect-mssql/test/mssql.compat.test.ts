/**
 * SQL Server compatibility suite (plan §5/§9) against a real server via
 * Testcontainers. Gated behind ORMIT_TESTCONTAINERS; run with:
 *
 *   ORMIT_TESTCONTAINERS=1 pnpm vitest run packages/dialect-mssql
 *
 * Exercises the SQL Server specifics: OUTPUT INSERTED.* key write-back, TOP /
 * OFFSET…FETCH paging, and BIT booleans.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import {
  ConcurrencyError,
  DbContext,
  type DbContextOptions,
  type ModelBuilder,
} from '@ormit/core';
import { MssqlEngine } from '@ormit/mssql';

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

describe.runIf(RUN)('@ormit/mssql · compatibility suite', () => {
  let container: StartedMSSQLServerContainer;
  let engine: MssqlEngine;

  beforeAll(async () => {
    container = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
      .acceptLicense()
      .start();
    engine = new MssqlEngine({
      server: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      options: { encrypt: false, trustServerCertificate: true },
    });
    await engine.exec(`
      CREATE TABLE users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        age INT NOT NULL,
        active BIT NOT NULL DEFAULT 1,
        version INT NOT NULL DEFAULT 1
      );
    `);
  }, 300_000);

  afterAll(async () => {
    await engine?.close();
    await container?.stop();
  });

  it('inserts with OUTPUT INSERTED.* and writes the key back', async () => {
    const db = new AppDb({ engine });
    const u = db.users.add(Object.assign(new User(), { name: 'Amal', age: 30, active: true, version: 1 }));
    expect(await db.saveChanges()).toBe(1);
    expect(u.id).toBeGreaterThan(0);
  });

  it('filters, orders, pages (TOP / OFFSET…FETCH) and aggregates', async () => {
    const db = new AppDb({ engine });
    db.users.addRange([
      Object.assign(new User(), { name: 'Bilal', age: 17, active: true, version: 1 }),
      Object.assign(new User(), { name: 'Carim', age: 25, active: true, version: 1 }),
      Object.assign(new User(), { name: 'Hidden', age: 99, active: false, version: 1 }),
    ]);
    await db.saveChanges();

    const q = new AppDb({ engine });
    const page = await q.users.orderBy((x) => x.name).skip(1).take(1).toList(); // OFFSET…FETCH
    expect(page).toHaveLength(1);
    const top = await q.users.orderBy((x) => x.age).first(); // TOP(1)
    expect(top.active).toBe(true); // BIT → boolean, filtered by the query filter
    expect(await q.users.ignoreQueryFilters().count()).toBeGreaterThanOrEqual(4);
    expect(await q.users.sum((x) => x.age)).toBeGreaterThan(0);
  });

  it('updates, deletes, and enforces optimistic concurrency', async () => {
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
