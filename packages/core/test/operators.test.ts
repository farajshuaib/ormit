import { describe, expect, it } from 'vitest';
import { createEntityRef, recordPredicate } from '@ormit/core';

interface Comment {
  published: boolean;
  score: number;
}
interface Post {
  id: number;
  title: string;
  comments: Comment[];
}
interface Blog {
  id: number;
  name: string;
  posts: Post[];
}

describe('FieldRef operator algebra (Phase 3)', () => {
  it('lowers string case functions into a chainable comparable', () => {
    const node = recordPredicate<Blog>((x) => x.name.toLower().eq('acme'));
    expect(node).toEqual({
      kind: 'binary',
      op: 'eq',
      left: { kind: 'function', name: 'lower', args: [{ kind: 'column', path: ['name'] }] },
      right: { kind: 'constant', value: 'acme' },
    });
  });

  it('supports nested function calls (toUpper ∘ toLower)', () => {
    const x = createEntityRef<Blog>();
    const node = x.name.toLower().toUpper().eq('X').node;
    expect(node).toMatchObject({
      left: {
        kind: 'function',
        name: 'upper',
        args: [{ kind: 'function', name: 'lower' }],
      },
    });
  });

  it('emits a raw LIKE pattern', () => {
    const node = recordPredicate<Blog>((x) => x.name.like('a_c%'));
    expect(node).toEqual({
      kind: 'like',
      mode: 'raw',
      target: { kind: 'column', path: ['name'] },
      value: 'a_c%',
    });
  });

  it('captures any() with a correlated predicate as EXISTS', () => {
    const node = recordPredicate<Blog>((x) => x.posts.any((p) => p.title.startsWith('Hello')));
    expect(node).toEqual({
      kind: 'exists',
      navigation: ['posts'],
      mode: 'any',
      predicate: {
        kind: 'like',
        mode: 'startsWith',
        target: { kind: 'column', path: ['title'] },
        value: 'Hello',
      },
    });
  });

  it('captures any() with no predicate (bare EXISTS)', () => {
    const node = recordPredicate<Blog>((x) => x.posts.any());
    expect(node).toEqual({ kind: 'exists', navigation: ['posts'], mode: 'any' });
    expect('predicate' in node).toBe(false);
  });

  it('captures all() as an EXISTS in all-mode', () => {
    const node = recordPredicate<Blog>((x) => x.posts.all((p) => p.id.gt(0)));
    expect(node).toMatchObject({ kind: 'exists', navigation: ['posts'], mode: 'all' });
  });

  it('captures count() as a comparable correlated aggregate', () => {
    const node = recordPredicate<Blog>((x) => x.posts.count().gt(5));
    expect(node).toEqual({
      kind: 'binary',
      op: 'gt',
      left: { kind: 'subaggregate', fn: 'count', navigation: ['posts'] },
      right: { kind: 'constant', value: 5 },
    });
  });

  it('composes nested navigations inside any()', () => {
    const node = recordPredicate<Blog>((x) =>
      x.posts.any((p) => p.comments.any((c) => c.published.eq(true))),
    );
    expect(node).toMatchObject({
      kind: 'exists',
      navigation: ['posts'],
      predicate: { kind: 'exists', navigation: ['comments'] },
    });
  });
});
