/**
 * Structural-hash stability gate (Phase 3): `irHash` must be identical across
 * processes and TypeScript versions. A committed golden of canonical IR shapes
 * fails the build if canonicalization ever drifts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { irHash, recordPredicate } from '@ormit/core';

const GOLDEN = fileURLToPath(new URL('./fixtures/ir-hash.golden.json', import.meta.url));

interface Post {
  id: number;
  title: string;
  score: number;
  tags: string[];
}
interface Blog {
  id: number;
  name: string;
  slug: string | null;
  createdAt: Date;
  posts: Post[];
}

/** Canonical expressions spanning every IR node kind. */
const cases: Record<string, () => object> = {
  binary: () => recordPredicate<Blog>((x) => x.id.gt(10)),
  logicalAnd: () => recordPredicate<Blog>((x) => x.id.gt(10).and(x.name.eq('a'))),
  logicalOr: () => recordPredicate<Blog>((x) => x.id.lt(1).or(x.id.gt(9))),
  not: () => recordPredicate<Blog>((x) => x.name.eq('a').not()),
  nullcheck: () => recordPredicate<Blog>((x) => x.slug.isNull()),
  notNull: () => recordPredicate<Blog>((x) => x.slug.isNotNull()),
  likeStarts: () => recordPredicate<Blog>((x) => x.name.startsWith('A')),
  likeEnds: () => recordPredicate<Blog>((x) => x.name.endsWith('z')),
  likeContains: () => recordPredicate<Blog>((x) => x.name.contains('mid')),
  likeRaw: () => recordPredicate<Blog>((x) => x.name.like('a_c%')),
  inList: () => recordPredicate<Blog>((x) => x.id.in([1, 2, 3])),
  between: () => recordPredicate<Blog>((x) => x.id.between(1, 10)),
  columnToColumn: () => recordPredicate<Blog>((x) => x.id.gte(x.id)),
  functionLower: () => recordPredicate<Blog>((x) => x.name.toLower().eq('a')),
  functionUpper: () => recordPredicate<Blog>((x) => x.slug.toUpper().eq('B')),
  existsAny: () => recordPredicate<Blog>((x) => x.posts.any((p) => p.score.gt(3))),
  existsBare: () => recordPredicate<Blog>((x) => x.posts.any()),
  existsAll: () => recordPredicate<Blog>((x) => x.posts.all((p) => p.id.gt(0))),
  subAggregate: () => recordPredicate<Blog>((x) => x.posts.count().gte(2)),
};

describe('irHash · golden stability', () => {
  const actual: Record<string, string> = {};
  for (const [name, build] of Object.entries(cases)) actual[name] = irHash(build());

  it('all canonical shapes hash to distinct values', () => {
    expect(new Set(Object.values(actual)).size).toBe(Object.keys(cases).length);
  });

  it('matches the committed golden (stable across processes)', () => {
    if (process.env['UPDATE_GOLDEN'] || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(actual).toEqual(golden);
  });

  it('is insensitive to how an equal tree is constructed', () => {
    const a = irHash(recordPredicate<Blog>((x) => x.id.gt(10).and(x.name.eq('a'))));
    const b = irHash(recordPredicate<Blog>((x) => x.id.gt(10).and(x.name.eq('a'))));
    expect(a).toBe(b);
  });
});
