import { describe, expect, it } from 'vitest';
import { conjuncts, optimize, recordPredicate } from '@ormit/core';
import type { BoolExprNode } from '@ormit/core';

const C = (value: unknown): BoolExprNode => ({
  kind: 'binary',
  op: 'eq',
  left: { kind: 'constant', value },
  right: { kind: 'constant', value },
});

const col = (name: string): BoolExprNode => ({
  kind: 'binary',
  op: 'gt',
  left: { kind: 'column', path: [name] },
  right: { kind: 'constant', value: 0 },
});

describe('optimizer · constant folding', () => {
  it('folds a comparison over two constants to a literal', () => {
    expect(
      optimize({
        kind: 'binary',
        op: 'gt',
        left: { kind: 'constant', value: 5 },
        right: { kind: 'constant', value: 3 },
      }),
    ).toEqual({ kind: 'lit', value: true });
  });

  it('folds nullcheck and in over constants', () => {
    expect(optimize({ kind: 'nullcheck', target: { kind: 'constant', value: null }, negated: false }))
      .toEqual({ kind: 'lit', value: true });
    expect(optimize({ kind: 'in', target: { kind: 'constant', value: 2 }, values: [1, 2, 3] }))
      .toEqual({ kind: 'lit', value: true });
  });

  it('leaves column comparisons untouched', () => {
    expect(optimize(col('age'))).toEqual(col('age'));
  });
});

describe('optimizer · logical simplification', () => {
  it('drops identity literals and collapses to the surviving clause', () => {
    const node: BoolExprNode = { kind: 'logical', op: 'and', operands: [C(1), col('age')] };
    expect(optimize(node)).toEqual(col('age')); // (true AND age>0) → age>0
  });

  it('short-circuits on an absorbing literal', () => {
    const node: BoolExprNode = {
      kind: 'logical',
      op: 'and',
      operands: [{ kind: 'binary', op: 'eq', left: { kind: 'constant', value: 1 }, right: { kind: 'constant', value: 2 } }, col('age')],
    };
    expect(optimize(node)).toEqual({ kind: 'lit', value: false }); // false AND … → false
  });

  it('flattens nested groups of the same operator', () => {
    const node: BoolExprNode = {
      kind: 'logical',
      op: 'and',
      operands: [col('a'), { kind: 'logical', op: 'and', operands: [col('b'), col('c')] }],
    };
    const out = optimize(node);
    expect(out).toMatchObject({ kind: 'logical', op: 'and' });
    expect((out as { operands: unknown[] }).operands).toHaveLength(3);
  });

  it('eliminates double negation and negates literals', () => {
    expect(optimize({ kind: 'not', operand: { kind: 'not', operand: col('age') } })).toEqual(col('age'));
    expect(optimize({ kind: 'not', operand: C(1) })).toEqual({ kind: 'lit', value: false });
  });

  it('is a no-op composed with the recorder for real predicates', () => {
    const node = recordPredicate<{ age: number; name: string }>((x) =>
      x.age.gt(18).and(x.name.eq('a')),
    );
    expect(optimize(node)).toEqual(node);
  });
});

describe('optimizer · conjunct splitting (pushdown enabler)', () => {
  it('flattens an AND tree into independent clauses', () => {
    const node: BoolExprNode = {
      kind: 'logical',
      op: 'and',
      operands: [col('a'), { kind: 'logical', op: 'and', operands: [col('b'), col('c')] }],
    };
    expect(conjuncts(node)).toEqual([col('a'), col('b'), col('c')]);
  });

  it('returns a single clause for a non-AND root', () => {
    expect(conjuncts(col('a'))).toEqual([col('a')]);
  });
});
