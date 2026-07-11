/**
 * Minification-robustness gate (Phase 3, ADR-001): because capture is
 * Proxy-based and never inspects `fn.toString()`, aggressive minification —
 * which mangles the lambda parameter names — must not change the recorded IR.
 *
 * The fixture is transformed by esbuild (identifier mangling) and then terser
 * (a second, independent minifier), executed, and compared to the IR produced
 * from the same expressions running unminified.
 */
import { describe, expect, it } from 'vitest';
import { transform } from 'esbuild';
import { minify } from 'terser';
import { irHash, recordPredicate, type BoolExpr, type EntityRef } from '@ormit/core';

interface Post {
  score: number;
}
interface Blog {
  id: number;
  name: string;
  tags: string[];
  posts: Post[];
}

// The expressions under test, as source text reused for both paths.
const FIXTURE_BODY = `(rp) => [
  rp((x) => x.id.gt(18).and(x.name.startsWith('A'))),
  rp((x) => x.tags.in(['news', 'tech'])),
  rp((x) => x.name.toLower().eq('bob')),
  rp((x) => x.posts.any((p) => p.score.gte(3))),
  rp((x) => x.posts.count().gt(2)),
];`;

type Builder = (rp: typeof recordPredicate) => unknown[];

async function loadMinified(): Promise<Builder> {
  const source = `export const build = ${FIXTURE_BODY}`;
  const esb = await transform(source, { minify: true, format: 'esm', target: 'es2022' });
  const terse = await minify(esb.code, { module: true, mangle: true, compress: true });
  const code = terse.code ?? esb.code;
  // Sanity: the lambda parameter `x` must actually have been mangled away.
  expect(code.includes('=>x.id')).toBe(false);
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  const mod = (await import(/* @vite-ignore */ url)) as { build: Builder };
  return mod.build;
}

describe('capture survives esbuild + terser minification', () => {
  it('produces IR identical to the unminified expressions', async () => {
    const build = await loadMinified();
    const minified = build(recordPredicate);

    const rp = recordPredicate as <T>(p: (x: EntityRef<T>) => BoolExpr) => BoolExpr['node'];
    const expected = [
      rp<Blog>((x) => x.id.gt(18).and(x.name.startsWith('A'))),
      rp<Blog>((x) => x.tags.in(['news', 'tech'])),
      rp<Blog>((x) => x.name.toLower().eq('bob')),
      rp<Blog>((x) => x.posts.any((p) => p.score.gte(3))),
      rp<Blog>((x) => x.posts.count().gt(2)),
    ];

    expect(minified).toEqual(expected);
    // Structural hashes match too — the cache key is minifier-invariant.
    expect(minified.map((n) => irHash(n as object))).toEqual(
      expected.map((n) => irHash(n as object)),
    );
  });
});
