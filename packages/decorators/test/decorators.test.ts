import { beforeEach, describe, expect, it } from 'vitest';
import { ModelBuilder, ModelSnapshot } from '@ormit/core';
import {
  applyDecorators,
  clearDecoratorRegistry,
  column,
  entity,
  hasMany,
  hasOne,
  key,
} from '@ormit/decorators';

class User {
  id!: number;
  name!: string;
  posts!: Post[];
}
class Post {
  id!: number;
  title!: string;
  authorId!: number;
  author!: User;
}

// Applied as plain functions (equivalent to @decorator syntax).
function decorate(): void {
  entity({ table: 'users' })(User);
  key()(User.prototype, 'id');
  column({ maxLength: 80 })(User.prototype, 'name');
  hasMany(() => Post, { foreignKey: 'authorId' })(User.prototype, 'posts');

  entity({ table: 'posts' })(Post);
  key()(Post.prototype, 'id');
  column({ maxLength: 200 })(Post.prototype, 'title');
  hasOne(() => User, { foreignKey: 'authorId' })(Post.prototype, 'author');
}

beforeEach(() => clearDecoratorRegistry());

describe('@ormit/decorators · replay into ModelBuilder', () => {
  it('produces the same snapshot as the equivalent fluent model', () => {
    decorate();
    const m = new ModelBuilder();
    applyDecorators(m, [User, Post]);
    const snap = ModelSnapshot.build(m);

    expect(snap.entity('User')!.table).toBe('users');
    expect(snap.entity('User')!.key).toEqual(['id']);
    expect(snap.entity('User')!.properties.find((p) => p.name === 'name')!.maxLength).toBe(80);

    const author = snap.entity('Post')!.navigations.find((n) => n.name === 'author')!;
    expect(author).toMatchObject({ target: 'User', collection: false, foreignKey: ['authorId'] });
    const posts = snap.entity('User')!.navigations.find((n) => n.name === 'posts')!;
    expect(posts).toMatchObject({ target: 'Post', collection: true });
  });

  it('honors convention < decorator < fluent precedence', () => {
    decorate();
    const m = new ModelBuilder();
    applyDecorators(m, [User, Post]);
    // Fluent override after decorators wins.
    m.configure(User, (e) => e.toTable('app_users'));
    const snap = ModelSnapshot.build(m);
    expect(snap.entity('User')!.table).toBe('app_users');
  });
});
