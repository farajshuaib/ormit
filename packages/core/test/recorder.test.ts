import { describe, expect, it } from 'vitest';
import {
  createEntityRef,
  irHash,
  recordPath,
  recordPredicate,
  TranslationError,
} from '@ormit/core';

interface User {
  id: number;
  name: string;
  age: number;
  email: string | null;
  address: { city: string };
}

describe('expression recorder (ADR-001)', () => {
  it('captures comparison + logical composition as IR', () => {
    const node = recordPredicate<User>((x) => x.age.gt(18).and(x.name.startsWith('A')));
    expect(node).toEqual({
      kind: 'logical',
      op: 'and',
      operands: [
        {
          kind: 'binary',
          op: 'gt',
          left: { kind: 'column', path: ['age'] },
          right: { kind: 'constant', value: 18 },
        },
        { kind: 'like', target: { kind: 'column', path: ['name'] }, mode: 'startsWith', value: 'A' },
      ],
    });
  });

  it('supports column-to-column comparison and null checks', () => {
    const x = createEntityRef<User>();
    const node = x.email.isNull().or(x.age.gte(x.id));
    expect(node.node).toMatchObject({
      kind: 'logical',
      op: 'or',
      operands: [
        { kind: 'nullcheck', negated: false },
        { kind: 'binary', op: 'gte', right: { kind: 'column', path: ['id'] } },
      ],
    });
  });

  it('records nested property paths (owned types)', () => {
    expect(recordPath<User>((x) => x.address.city)).toEqual(['address', 'city']);
  });

  it('rejects untranslatable selectors loudly (never silent)', () => {
    expect(() => recordPath<User>(() => 42)).toThrow(TranslationError);
    // @ts-expect-error plain boolean is not a BoolExpr
    expect(() => recordPredicate<User>((x) => true)).toThrow(TranslationError);
  });

  it('produces stable structural hashes (golden)', () => {
    const a = recordPredicate<User>((x) => x.age.gt(18));
    const b = recordPredicate<User>((x) => x.age.gt(18));
    const c = recordPredicate<User>((x) => x.age.gt(19));
    expect(irHash(a)).toBe(irHash(b));
    expect(irHash(a)).not.toBe(irHash(c));
    expect(irHash(a)).toBe('71b2bb3b'); // golden: fails if canonicalization drifts
  });
});
