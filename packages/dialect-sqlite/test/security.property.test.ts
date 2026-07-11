/**
 * Security review (Phase 9 gate): SQL-injection fuzzing over `fromSql` and the
 * identifier path. Interpolations become bound parameters, never SQL text, so
 * classic payloads round-trip as inert string literals and cannot alter the
 * schema or leak rows.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class User {
  id!: number;
  name!: string;
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

let engine: SqliteEngine;
let db: AppDb;
beforeEach(async () => {
  engine = new SqliteEngine(':memory:');
  engine.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);`);
  db = new AppDb({ engine });
  db.users.addRange([
    Object.assign(new User(), { name: 'Alice' }),
    Object.assign(new User(), { name: 'Bob' }),
  ]);
  await db.saveChanges();
});
afterAll(() => engine.close());

const PAYLOADS = [
  `' OR '1'='1`,
  `'; DROP TABLE users; --`,
  `Robert'); DROP TABLE users;--`,
  `" OR ""="`,
  `1); DELETE FROM users; --`,
  `' UNION SELECT id, name FROM users --`,
];

describe('fromSql · injection is neutralized by parameterization', () => {
  it('treats classic payloads as inert string literals', async () => {
    for (const payload of PAYLOADS) {
      const rows = await db.users.fromSql`SELECT * FROM users WHERE name = ${payload}`.toList();
      expect(rows).toHaveLength(0); // no user is literally named the payload
      expect(await new AppDb({ engine }).users.count()).toBe(2); // schema + rows intact
    }
  });

  it('binds the interpolation as a parameter, not SQL text (fuzz)', () => {
    const strings = ['SELECT * FROM users WHERE name = ', ''];
    const compile = (v: string) =>
      engine.generator.compileRaw(strings, [v], { tables: new Map() });
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const ca = compile(a);
        const cb = compile(b);
        // SQL invariant to the value ⇒ never interpolated; value is bound.
        return ca.sql === cb.sql && ca.params[0] === a && cb.params[0] === b;
      }),
      { numRuns: 200 },
    );
  });

  it('a matching literal still works (a real value, not ignored)', async () => {
    const rows = await db.users.fromSql`SELECT * FROM users WHERE name = ${'Alice'}`.toList();
    expect(rows.map((u) => u.name)).toEqual(['Alice']);
  });
});
