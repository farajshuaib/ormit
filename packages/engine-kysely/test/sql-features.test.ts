/**
 * SQL snapshot suite for the Phase-4 query surface (aggregates, distinct,
 * projections, string functions, LIKE modes) across Postgres and SQLite.
 */
import { describe, expect, it } from 'vitest';
import { recordPredicate, type GenContext, type SelectExpr } from '@ormit/core';
import { KyselySqlGenerator } from '@ormit/engine-kysely';

interface User {
  id: number;
  name: string;
  age: number;
}

const ctx: GenContext = { tables: new Map([['User', 'users']]) };
const base: SelectExpr = { kind: 'select', entity: 'User', orderings: [] };
const pg = new KyselySqlGenerator('postgres');
const sqlite = new KyselySqlGenerator('sqlite');
const mysql = new KyselySqlGenerator('mysql');
const mssql = new KyselySqlGenerator('mssql');

describe('SQL features · aggregates', () => {
  it('count(*) (postgres)', () => {
    expect(pg.compileSelect({ ...base, aggregate: { fn: 'count' } }, ctx).sql).toBe(
      'select count(*) as "value" from "users"',
    );
  });

  it('sum over a column (postgres)', () => {
    expect(pg.compileSelect({ ...base, aggregate: { fn: 'sum', path: ['age'] } }, ctx).sql).toBe(
      'select sum("age") as "value" from "users"',
    );
  });

  it('avg with a predicate (sqlite)', () => {
    const cmd = sqlite.compileSelect(
      {
        ...base,
        aggregate: { fn: 'avg', path: ['age'] },
        predicate: recordPredicate<User>((x) => x.age.gt(18)),
      },
      ctx,
    );
    expect(cmd.sql).toBe('select avg("age") as "value" from "users" where "age" > ?');
    expect(cmd.params).toEqual([18]);
  });
});

describe('SQL features · distinct + projection', () => {
  it('select distinct projected columns (postgres)', () => {
    const cmd = pg.compileSelect(
      { ...base, projection: { n: ['name'], a: ['age'] }, distinct: true },
      ctx,
    );
    expect(cmd.sql).toBe('select distinct "name" as "n", "age" as "a" from "users"');
  });
});

describe('SQL features · dialect deltas (4-dialect matrix)', () => {
  const query: SelectExpr = {
    ...base,
    predicate: recordPredicate<User>((x) => x.age.gt(18)),
    orderings: [{ path: ['name'], direction: 'asc' }],
    skip: 20,
    take: 10,
  };

  it('postgres/mysql use LIMIT/OFFSET with their own placeholders', () => {
    expect(pg.compileSelect(query, ctx).sql).toBe(
      'select * from "users" where "age" > $1 order by "name" asc limit $2 offset $3',
    );
    expect(mysql.compileSelect(query, ctx).sql).toBe(
      'select * from `users` where `age` > ? order by `name` asc limit ? offset ?',
    );
  });

  it('mssql uses @n placeholders and OFFSET…FETCH paging (never LIMIT)', () => {
    const sql = mssql.compileSelect(query, ctx).sql;
    expect(sql).toContain('@1'); // named placeholders, not $1 / ?
    expect(sql).not.toContain('$1');
    expect(sql).not.toContain('limit'); // SQL Server has no LIMIT
    expect(sql).toContain('offset');
    expect(sql).toContain('fetch next');
  });

  it('mssql take-only uses TOP and insert uses OUTPUT INSERTED.*', () => {
    const top = mssql.compileSelect({ ...base, take: 1 }, ctx).sql;
    expect(top).toContain('top(1)');
    const ins = mssql.compileWrite({ kind: 'insert', entity: 'User', values: { name: 'A' } }, ctx).sql;
    expect(ins).toContain('output "inserted".*');
  });

  it('all four dialects parameterize constants (no inlining)', () => {
    // Every constant (predicate 18, take 10, skip 20) is bound, not inlined.
    // Order varies by dialect (MSSQL emits OFFSET before FETCH), so compare sets.
    for (const gen of [pg, sqlite, mysql, mssql]) {
      const cmd = gen.compileSelect(query, ctx);
      expect([...cmd.params].sort((a, b) => Number(a) - Number(b))).toEqual([10, 18, 20]);
    }
  });
});

describe('SQL features · string functions and LIKE modes', () => {
  it('lower(name) = ? (sqlite)', () => {
    const cmd = sqlite.compileSelect(
      { ...base, predicate: recordPredicate<User>((x) => x.name.toLower().eq('bob')) },
      ctx,
    );
    expect(cmd.sql).toBe('select * from "users" where lower("name") = ?');
    expect(cmd.params).toEqual(['bob']);
  });

  it('raw LIKE keeps the pattern verbatim (postgres)', () => {
    const cmd = pg.compileSelect(
      { ...base, predicate: recordPredicate<User>((x) => x.name.like('a_c%')) },
      ctx,
    );
    expect(cmd.sql).toBe('select * from "users" where "name" like $1');
    expect(cmd.params).toEqual(['a_c%']);
  });

  it('endsWith / contains wrap with % (postgres)', () => {
    const ends = pg.compileSelect(
      { ...base, predicate: recordPredicate<User>((x) => x.name.endsWith('z')) },
      ctx,
    );
    expect(ends.params).toEqual(['%z']);
    const has = pg.compileSelect(
      { ...base, predicate: recordPredicate<User>((x) => x.name.contains('mid')) },
      ctx,
    );
    expect(has.params).toEqual(['%mid%']);
  });
});
