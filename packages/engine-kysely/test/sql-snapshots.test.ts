import { describe, expect, it } from 'vitest';
import { recordPredicate, type GenContext, type SelectExpr } from '@ormit/core';
import { KyselySqlGenerator } from '@ormit/engine-kysely';

interface User { id: number; name: string; age: number; email: string | null }

const ctx: GenContext = { tables: new Map([['User', 'users']]) };
const base: SelectExpr = { kind: 'select', entity: 'User', orderings: [] };

describe('KyselySqlGenerator (ADR-002) — SQL snapshots', () => {
  it('compiles filtered, ordered, paged select (postgres)', () => {
    const gen = new KyselySqlGenerator('postgres');
    const cmd = gen.compileSelect(
      {
        ...base,
        predicate: recordPredicate<User>((x) => x.age.gt(18).and(x.name.startsWith('A'))),
        orderings: [{ path: ['name'], direction: 'asc' }],
        skip: 20,
        take: 10,
      },
      ctx,
    );
    expect(cmd.sql).toBe(
      'select * from "users" where ("age" > $1 and "name" like $2) order by "name" asc limit $3 offset $4',
    );
    expect(cmd.params).toEqual([18, 'A%', 10, 20]);
  });

  it('same IR ⇒ same SQL and same irHash (determinism gate)', () => {
    const gen = new KyselySqlGenerator('postgres');
    const build = () =>
      gen.compileSelect(
        { ...base, predicate: recordPredicate<User>((x) => x.email.isNotNull()) },
        ctx,
      );
    const a = build();
    const b = build();
    expect(a.sql).toBe(b.sql);
    expect(a.irHash).toBe(b.irHash);
  });

  it('dialect delta: sqlite uses ? params', () => {
    const gen = new KyselySqlGenerator('sqlite');
    const cmd = gen.compileSelect(
      { ...base, predicate: recordPredicate<User>((x) => x.id.in([1, 2, 3])) },
      ctx,
    );
    expect(cmd.sql).toBe('select * from "users" where "id" in (?, ?, ?)');
    expect(cmd.params).toEqual([1, 2, 3]);
  });

  it('compiles insert with RETURNING (postgres) and delete', () => {
    const gen = new KyselySqlGenerator('postgres');
    const ins = gen.compileWrite(
      { kind: 'insert', entity: 'User', values: { name: 'faraj', age: 28 } },
      ctx,
    );
    expect(ins.sql).toBe('insert into "users" ("name", "age") values ($1, $2) returning *');

    const del = gen.compileWrite(
      { kind: 'delete', entity: 'User', predicate: recordPredicate<User>((x) => x.id.eq(5)) },
      ctx,
    );
    expect(del.sql).toBe('delete from "users" where "id" = $1');
    expect(del.params).toEqual([5]);
  });
});
