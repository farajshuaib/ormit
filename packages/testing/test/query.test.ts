import { describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { InMemoryEngine } from '@ormit/testing';

class Product {
  id!: number;
  name!: string;
  category!: string;
  price!: number;
  active!: boolean;
}

class ShopDb extends DbContext {
  products = this.set(Product);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(Product, (e) => {
      e.toTable('products').hasKey('id');
      e.property((x) => x.name).hasColumnName('label');
      e.hasQueryFilter((x) => x.active.eq(true));
    });
  }
}

function makeDb() {
  const engine = new InMemoryEngine();
  engine.seed('products', [
    { id: 1, label: 'Apple', category: 'fruit', price: 3, active: true },
    { id: 2, label: 'Banana', category: 'fruit', price: 2, active: true },
    { id: 3, label: 'Carrot', category: 'veg', price: 5, active: true },
    { id: 4, label: 'Expired', category: 'veg', price: 9, active: false },
  ]);
  return { engine, db: new ShopDb({ engine }) };
}

describe('query pipeline · global query filters', () => {
  it('injects the entity query filter into every read', async () => {
    const { db } = makeDb();
    expect(await db.products.count()).toBe(3); // active only
    const all = await db.products.toList();
    expect(all.every((p) => p.active)).toBe(true);
  });

  it('honors ignoreQueryFilters()', async () => {
    const { db } = makeDb();
    expect(await db.products.ignoreQueryFilters().count()).toBe(4);
  });

  it('composes the filter with an explicit where', async () => {
    const { db } = makeDb();
    const veg = await db.products.where((x) => x.category.eq('veg')).toList();
    expect(veg.map((p) => p.id)).toEqual([3]); // id 4 excluded by the filter
  });
});

describe('query pipeline · aggregates', () => {
  it('sum / avg / min / max over the filtered set', async () => {
    const { db } = makeDb();
    expect(await db.products.sum((x) => x.price)).toBe(10); // 3+2+5
    expect(await db.products.avg((x) => x.price)).toBeCloseTo(10 / 3);
    expect(await db.products.min((x) => x.price)).toBe(2);
    expect(await db.products.max((x) => x.price)).toBe(5);
  });
});

describe('query pipeline · projections and distinct', () => {
  it('projects rows into a new shape', async () => {
    const { db } = makeDb();
    const rows = await db.products
      .orderBy((x) => x.id)
      .select((x) => ({ id: x.id, kind: x.category }))
      .toList();
    expect(rows).toEqual([
      { id: 1, kind: 'fruit' },
      { id: 2, kind: 'fruit' },
      { id: 3, kind: 'veg' },
    ]);
  });

  it('distinct collapses duplicate projected rows', async () => {
    const { db } = makeDb();
    const cats = await db.products.select((x) => ({ category: x.category })).distinct().toList();
    expect(cats).toEqual([{ category: 'fruit' }, { category: 'veg' }]);
  });
});

describe('query pipeline · compiled-query cache', () => {
  it('compiles a repeated query shape only once', async () => {
    const { db, engine } = makeDb();
    let compiles = 0;
    const original = engine.generator.compileSelect.bind(engine.generator);
    engine.generator.compileSelect = (q, ctx) => {
      compiles++;
      return original(q, ctx);
    };
    await db.products.where((x) => x.category.eq('fruit')).toList();
    await db.products.where((x) => x.category.eq('fruit')).toList();
    expect(compiles).toBe(1); // second execution served from the LRU
  });
});

describe('query pipeline · single / column overrides', () => {
  it('single returns the sole match', async () => {
    const { db } = makeDb();
    const carrot = await db.products.where((x) => x.category.eq('veg')).single();
    expect(carrot.name).toBe('Carrot');
  });

  it('single throws when more than one matches', async () => {
    const { db } = makeDb();
    await expect(db.products.where((x) => x.category.eq('fruit')).single()).rejects.toThrow();
  });

  it('singleOrNull returns null when nothing matches', async () => {
    const { db } = makeDb();
    expect(await db.products.where((x) => x.category.eq('none')).singleOrNull()).toBeNull();
  });

  it('resolves a column-name override through the pipeline (name → label)', async () => {
    const { db } = makeDb();
    // The predicate references the JS property `name`; the pipeline rewrites it
    // to the physical column `label` before hitting the engine.
    const apple = await db.products.where((x) => x.name.eq('Apple')).single();
    expect(apple.name).toBe('Apple');
  });
});
