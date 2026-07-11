import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ModelBuilder, ModelSnapshot } from '@ormit/core';

const GOLDEN = fileURLToPath(new URL('./fixtures/rich-model.snapshot.json', import.meta.url));

// ---- Domain used across the metadata tests ----
class User {
  id!: number;
  name!: string;
  email!: string | null;
  createdAt!: Date;
  address!: Address;
  posts!: Post[];
  roles!: Role[];
}
class Address {
  city!: string;
  zip!: string;
}
class Post {
  id!: number;
  title!: string;
  body!: string;
  authorId!: number;
  author!: User;
  comments!: Comment[];
}
class Comment {
  id!: number;
  text!: string;
  postId!: number;
}
class Role {
  id!: number;
  name!: string;
  users!: User[];
}
class OrderLineItem {
  orderId!: number;
  lineNo!: number;
  sku!: string;
}

/** A model that touches every Phase-2 feature. */
function buildRichModel(): ModelBuilder {
  const m = new ModelBuilder();

  m.entity(User, (e) => {
    e.toTable('users', 'app');
    e.hasKey('id');
    e.property((x) => x.name).hasMaxLength(120).isRequired();
    e.property((x) => x.email).isRequired(false).hasColumnName('email_address');
    e.property((x) => x.createdAt).hasDefaultSql('now()').valueGenerated('onAdd');
    e.hasIndex('email').isUnique();
    e.ownsOne(Address, (x) => x.address, (a) => {
      a.property((p) => p.city).hasMaxLength(80);
      a.property((p) => p.zip).hasMaxLength(10);
    });
    e.hasMany(Post, (x) => x.posts).withOne((p) => p.author).onDelete('cascade');
    e.hasMany(Role, (x) => x.roles).withMany((r) => r.users);
    e.hasData({ id: 1, name: 'Root' });
  });

  m.entity(Post, (e) => {
    e.hasKey('id');
    e.property((x) => x.title).hasMaxLength(200);
    e.property((x) => x.body).hasConversion('markdown');
    e.hasQueryFilter((x) => x.title.isNotNull());
    e.hasMany(Comment, (x) => x.comments).withOne();
  });

  m.entity(Comment, (e) => e.hasKey('id'));
  m.entity(Role, (e) => e.hasKey('id'));

  // Composite key.
  m.entity(OrderLineItem, (e) => {
    e.toTable('order_line_items');
    e.hasKey('orderId', 'lineNo');
    e.property((x) => x.sku).hasMaxLength(32).isConcurrencyToken();
  });

  return m;
}

describe('ModelSnapshot · construction', () => {
  const snap = ModelSnapshot.build(buildRichModel());

  it('applies table-naming conventions and explicit overrides', () => {
    expect(snap.entity('User')!.table).toBe('users'); // explicit
    expect(snap.entity('User')!.schema).toBe('app');
    expect(snap.entity('Comment')!.table).toBe('Comments'); // convention (pluralize)
    expect(snap.entity('Role')!.table).toBe('Roles');
  });

  it('resolves single and composite keys', () => {
    expect(snap.entity('Post')!.key).toEqual(['id']);
    expect(snap.entity('OrderLineItem')!.key).toEqual(['orderId', 'lineNo']);
  });

  it('auto-increments a sole numeric-ish key but not composite keys', () => {
    const postId = snap.entity('Post')!.properties.find((p) => p.name === 'id')!;
    expect(postId.valueGenerated).toBe('onAdd');
    const orderId = snap.entity('OrderLineItem')!.properties.find((p) => p.name === 'orderId')!;
    expect(orderId.valueGenerated).toBe('never');
  });

  it('carries property configuration', () => {
    const name = snap.entity('User')!.properties.find((p) => p.name === 'name')!;
    expect(name).toMatchObject({ column: 'name', maxLength: 120, nullable: false, type: 'string' });
    const email = snap.entity('User')!.properties.find((p) => p.name === 'email')!;
    expect(email).toMatchObject({ column: 'email_address', nullable: true });
    const createdAt = snap.entity('User')!.properties.find((p) => p.name === 'createdAt')!;
    expect(createdAt.defaultValueSql).toBe('now()');
    const body = snap.entity('Post')!.properties.find((p) => p.name === 'body')!;
    expect(body.conversion).toBe('markdown');
    const sku = snap.entity('OrderLineItem')!.properties.find((p) => p.name === 'sku')!;
    expect(sku.concurrencyToken).toBe(true);
  });

  it('flattens an owned type into prefixed columns sharing the owner table', () => {
    const address = snap.entity('Address')!;
    expect(address.owned).toBe(true);
    expect(address.table).toBe('users');
    expect(address.schema).toBe('app');
    expect(address.key).toEqual([]);
    const city = address.properties.find((p) => p.name === 'city')!;
    expect(city.column).toBe('address_city');
  });

  it('discovers the foreign key for a one-to-many and wires the inverse', () => {
    const posts = snap.entity('User')!.navigations.find((n) => n.name === 'posts')!;
    expect(posts).toMatchObject({ target: 'Post', collection: true, foreignKey: ['authorId'] });
    const author = snap.entity('Post')!.navigations.find((n) => n.name === 'author')!;
    expect(author).toMatchObject({ target: 'User', collection: false, inverse: 'posts' });
    // The discovered FK became a column on the dependent.
    expect(snap.entity('Post')!.properties.some((p) => p.name === 'authorId')).toBe(true);
  });

  it('models many-to-many as reciprocal collections', () => {
    const roles = snap.entity('User')!.navigations.find((n) => n.name === 'roles')!;
    expect(roles).toMatchObject({ target: 'Role', collection: true });
    const users = snap.entity('Role')!.navigations.find((n) => n.name === 'users')!;
    expect(users).toMatchObject({ target: 'User', collection: true, inverse: 'roles' });
  });

  it('stores the query filter as expression IR', () => {
    const filter = snap.entity('Post')!.queryFilter as { kind: string };
    expect(filter.kind).toBe('nullcheck');
  });

  it('records indexes and seed data', () => {
    expect(snap.entity('User')!.indexes).toEqual([
      { name: 'IX_users_email', properties: ['email'], unique: true },
    ]);
    expect(snap.entity('User')!.seedData).toEqual([{ id: 1, name: 'Root' }]);
  });

  it('exposes the GenContext table map', () => {
    expect(snap.tables.get('OrderLineItem')).toBe('order_line_items');
  });
});

class Tag {
  label!: string;
}
class Owner {
  id!: number;
  tags!: Tag[];
}
class Manager {
  id!: number;
  reports!: Employee[];
}
class Employee {
  id!: number;
  manager!: Manager | null;
}
class Dog {
  id!: number;
}
class Cat {
  id!: number;
}

describe('ModelSnapshot · owned collections, TPH, optional FKs', () => {
  it('ownsMany creates a standalone owned table with a synthesized back-FK', () => {
    const m = new ModelBuilder();
    m.entity(Owner, (e) => {
      e.hasKey('id');
      e.ownsMany(Tag, (x) => x.tags, (t) => t.property((p) => p.label).hasMaxLength(40));
    });
    const snap = ModelSnapshot.build(m);
    const tag = snap.entity('Tag')!;
    expect(tag.owned).toBe(true);
    expect(tag.table).toBe('Tags'); // its own table, not the owner's
    expect(tag.key).toEqual([]);
    expect(tag.properties.some((p) => p.name === 'ownerId')).toBe(true);
    const nav = snap.entity('Owner')!.navigations.find((n) => n.name === 'tags')!;
    expect(nav).toMatchObject({ collection: true, owned: true, foreignKey: ['ownerId'] });
  });

  it('optional reference navigation yields a nullable FK and setNull delete', () => {
    const m = new ModelBuilder();
    m.entity(Manager, (e) => e.hasKey('id'));
    m.entity(Employee, (e) => {
      e.hasKey('id');
      e.hasOne(Manager, (x) => x.manager)
        .withMany((mgr) => mgr.reports)
        .hasForeignKey('managerId')
        .isRequired(false);
    });
    const snap = ModelSnapshot.build(m);
    const nav = snap.entity('Employee')!.navigations.find((n) => n.name === 'manager')!;
    expect(nav.deleteBehavior).toBe('setNull');
    const fk = snap.entity('Employee')!.properties.find((p) => p.name === 'managerId')!;
    expect(fk.nullable).toBe(true);
  });

  it('accepts a TPH hierarchy with distinct discriminator values on a shared table', () => {
    const m = new ModelBuilder();
    m.entity(Dog, (e) => e.toTable('animals').hasKey('id').hasDiscriminator('kind', 'dog'));
    m.entity(Cat, (e) => e.toTable('animals').hasKey('id').hasDiscriminator('kind', 'cat'));
    const snap = ModelSnapshot.build(m);
    expect(snap.entity('Dog')!.discriminator).toEqual({ column: 'kind', property: null, value: 'dog' });
    expect(snap.entity('Cat')!.discriminator!.value).toBe('cat');
  });
});

describe('ModelSnapshot · serialization', () => {
  it('round-trips byte-identical (the Phase 2 gate)', () => {
    const s1 = ModelSnapshot.build(buildRichModel()).toJSON();
    const s2 = ModelSnapshot.fromJSON(s1).toJSON();
    expect(s2).toBe(s1);
  });

  it('matches the committed golden snapshot (stable across processes)', () => {
    const actual = ModelSnapshot.build(buildRichModel()).toJSON();
    if (process.env['UPDATE_GOLDEN'] || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, actual);
    }
    expect(actual).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('is deterministic across independent builds', () => {
    const a = ModelSnapshot.build(buildRichModel()).toJSON();
    const b = ModelSnapshot.build(buildRichModel()).toJSON();
    expect(a).toBe(b);
  });

  it('sorts object keys regardless of insertion order', () => {
    const m1 = new ModelBuilder();
    m1.entity(Comment, (e) => {
      e.property((x) => x.text);
      e.hasKey('id');
    });
    const m2 = new ModelBuilder();
    m2.entity(Comment, (e) => {
      e.hasKey('id');
      e.property((x) => x.text);
    });
    expect(ModelSnapshot.build(m1).toJSON()).toBe(ModelSnapshot.build(m2).toJSON());
  });
});
