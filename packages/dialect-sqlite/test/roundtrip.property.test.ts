/**
 * Property-based IR → SQL round-trip (Phase 4 gate).
 *
 * For a fixed dataset loaded into both real SQLite and the in-memory reference
 * engine, a randomly generated predicate must select the same rows through the
 * compiled SQL as it does under the reference IR interpreter. This exercises
 * the whole lowering path (IR → Kysely OperationNode → SQLite SQL → execution)
 * against an independent oracle.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import fc from 'fast-check';
import type {
  BoolExprNode,
  GenContext,
  OrmEngine,
  SelectExpr,
  ValueExpr,
} from '@ormit/core';
import { InMemoryEngine } from '@ormit/testing';
import { SqliteEngine } from '@ormit/sqlite';

interface Person {
  id: number;
  age: number;
  score: number;
  active: boolean;
}

const PEOPLE: Person[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  age: (i * 7) % 60,
  score: (i * 13) % 100,
  active: i % 3 === 0,
}));

const CTX: GenContext = { tables: new Map([['Person', 'people']]) };

let sqlite: SqliteEngine;
let memory: InMemoryEngine;

beforeAll(() => {
  sqlite = new SqliteEngine(':memory:');
  sqlite.exec(
    `CREATE TABLE people (id INTEGER PRIMARY KEY, age INTEGER, score INTEGER, active INTEGER);`,
  );
  const insert = sqlite.db.prepare('INSERT INTO people (id, age, score, active) VALUES (?, ?, ?, ?)');
  for (const p of PEOPLE) insert.run(p.id, p.age, p.score, p.active ? 1 : 0);

  memory = new InMemoryEngine();
  memory.seed('people', PEOPLE.map((p) => ({ ...p })));
});

afterAll(() => sqlite.close());

const col = (name: string): ValueExpr => ({ kind: 'column', path: [name] });
const konst = (value: unknown): ValueExpr => ({ kind: 'constant', value });

// Arbitraries for a predicate over the numeric/boolean columns.
const numColumn = fc.constantFrom('age', 'score');
const cmpOp = fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte');

const numericLeaf: fc.Arbitrary<BoolExprNode> = fc
  .tuple(numColumn, cmpOp, fc.integer({ min: -5, max: 105 }))
  .map(([name, op, value]) => ({ kind: 'binary', op, left: col(name), right: konst(value) }) as BoolExprNode);

const boolLeaf: fc.Arbitrary<BoolExprNode> = fc
  .boolean()
  .map((b) => ({ kind: 'binary', op: 'eq', left: col('active'), right: konst(b) }) as BoolExprNode);

const inLeaf: fc.Arbitrary<BoolExprNode> = fc
  .tuple(numColumn, fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 5 }))
  .map(([name, values]) => ({ kind: 'in', target: col(name), values }) as BoolExprNode);

const leaf = fc.oneof(numericLeaf, boolLeaf, inLeaf);

const predicate: fc.Arbitrary<BoolExprNode> = fc.letrec<{ node: BoolExprNode }>((tie) => ({
  node: fc.oneof(
    { weight: 3, arbitrary: leaf },
    { weight: 1, arbitrary: tie('node').map((n) => ({ kind: 'not', operand: n }) as BoolExprNode) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom('and', 'or'), tie('node'), tie('node'))
        .map(([op, a, b]) => ({ kind: 'logical', op, operands: [a, b] }) as BoolExprNode),
    },
  ),
})).node;

async function idsFor(engine: OrmEngine, pred: BoolExprNode): Promise<number[]> {
  const select: SelectExpr = {
    kind: 'select',
    entity: 'Person',
    predicate: pred,
    orderings: [{ path: ['id'], direction: 'asc' }],
  };
  const cmd = engine.generator.compileSelect(select, CTX);
  const rows = await engine.executor.query(cmd);
  return rows.map((r) => Number(r['id'])).sort((a, b) => a - b);
}

describe('IR → SQL round-trip vs. reference interpreter', () => {
  it('selects identical rows for random predicates', async () => {
    await fc.assert(
      fc.asyncProperty(predicate, async (pred) => {
        const [fromSql, fromRef] = await Promise.all([idsFor(sqlite, pred), idsFor(memory, pred)]);
        return JSON.stringify(fromSql) === JSON.stringify(fromRef);
      }),
      { numRuns: 300 },
    );
  });
});
