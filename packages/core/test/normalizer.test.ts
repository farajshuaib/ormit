import { describe, expect, it } from 'vitest';
import {
  ModelBuilder,
  ModelSnapshot,
  injectQueryFilters,
  normalize,
  resolveColumns,
} from '@ormit/core';
import type { SelectExpr } from '@ormit/core';

class Address {
  city!: string;
  zip!: string;
}
class User {
  id!: number;
  email!: string | null;
  address!: Address;
  posts!: Post[];
}
class Post {
  id!: number;
  title!: string;
}

function snapshot(): ModelSnapshot {
  const m = new ModelBuilder();
  m.entity(User, (e) => {
    e.hasKey('id');
    e.property((x) => x.email).hasColumnName('email_address');
    e.ownsOne(Address, (x) => x.address, (a) => {
      a.property((p) => p.city).hasColumnName('addr_city');
    });
    e.hasQueryFilter((x) => x.email.isNotNull());
    e.hasMany(Post, (x) => x.posts).withOne();
  });
  m.entity(Post, (e) => e.hasKey('id'));
  return ModelSnapshot.build(m);
}

const baseSelect = (predicate?: SelectExpr['predicate']): SelectExpr => ({
  kind: 'select',
  entity: 'User',
  orderings: [],
  ...(predicate ? { predicate } : {}),
});

describe('normalizer · query filter injection', () => {
  it('ANDs the stored filter into an existing predicate', () => {
    const select = baseSelect({
      kind: 'binary',
      op: 'eq',
      left: { kind: 'column', path: ['id'] },
      right: { kind: 'constant', value: 1 },
    });
    const out = injectQueryFilters(select, snapshot());
    expect(out.predicate).toMatchObject({
      kind: 'logical',
      op: 'and',
      operands: [{ kind: 'nullcheck', negated: true }, { kind: 'binary', op: 'eq' }],
    });
  });

  it('uses the filter alone when there is no predicate', () => {
    const out = injectQueryFilters(baseSelect(), snapshot());
    expect(out.predicate).toMatchObject({ kind: 'nullcheck', negated: true });
  });

  it('is skipped when ignoreQueryFilters is set', () => {
    const out = normalize(baseSelect(), snapshot(), { ignoreQueryFilters: true });
    expect(out.predicate).toBeUndefined();
  });
});

describe('normalizer · column resolution', () => {
  const snap = snapshot();

  it('applies a column-name override on a scalar property', () => {
    const select = resolveColumns(
      baseSelect({ kind: 'nullcheck', target: { kind: 'column', path: ['email'] }, negated: true }),
      snap,
    );
    expect(select.predicate).toEqual({
      kind: 'nullcheck',
      target: { kind: 'column', path: ['email_address'] },
      negated: true,
    });
  });

  it('flattens an owned navigation path to its physical column', () => {
    const select = resolveColumns(
      baseSelect({
        kind: 'binary',
        op: 'eq',
        left: { kind: 'column', path: ['address', 'city'] },
        right: { kind: 'constant', value: 'Cairo' },
      }),
      snap,
    );
    // Owned column = owner-navigation prefix + the owned property's column.
    expect(select.predicate).toMatchObject({
      left: { kind: 'column', path: ['address_addr_city'] },
    });
  });

  it('leaves a regular (non-owned) navigation path for the join layer', () => {
    const select = resolveColumns(
      baseSelect({
        kind: 'binary',
        op: 'eq',
        left: { kind: 'column', path: ['posts', 'title'] },
        right: { kind: 'constant', value: 'Hi' },
      }),
      snap,
    );
    expect(select.predicate).toMatchObject({ left: { kind: 'column', path: ['posts', 'title'] } });
  });

  it('leaves unmapped scalar paths unchanged (no reflection required)', () => {
    const select = resolveColumns(
      baseSelect({
        kind: 'binary',
        op: 'gt',
        left: { kind: 'column', path: ['id'] },
        right: { kind: 'constant', value: 0 },
      }),
      snap,
    );
    expect(select.predicate).toMatchObject({ left: { kind: 'column', path: ['id'] } });
  });

  it('resolves order-by and projection paths too', () => {
    const select = resolveColumns(
      { ...baseSelect(), orderings: [{ path: ['email'], direction: 'asc' }], projection: { e: ['email'] } },
      snap,
    );
    expect(select.orderings[0]!.path).toEqual(['email_address']);
    expect(select.projection).toEqual({ e: ['email_address'] });
  });
});
