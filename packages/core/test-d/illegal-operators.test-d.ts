/**
 * Type-level gate (Phase 3): the FieldRef operator algebra must reject illegal
 * operator/property combinations at compile time. Each `@ts-expect-error` line
 * asserts a type error exists; `tsc --noEmit` over this file fails if any of
 * them stops erroring (or if a legal line below regresses).
 *
 * Run via `pnpm test:types`.
 */
import { recordPredicate } from '../src/index.js';

interface Model {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: Date;
  tags: string[];
  posts: Post[];
}
interface Post {
  id: number;
  score: number;
}

// ---- Legal usage: these must all type-check cleanly ----
recordPredicate<Model>((x) => x.id.gt(18));
recordPredicate<Model>((x) => x.name.startsWith('A'));
recordPredicate<Model>((x) => x.name.between('a', 'z')); // strings are ordered
recordPredicate<Model>((x) => x.name.toLower().eq('bob'));
recordPredicate<Model>((x) => x.createdAt.gte(new Date()));
recordPredicate<Model>((x) => x.isActive.eq(true));
recordPredicate<Model>((x) => x.id.in([1, 2, 3]));
recordPredicate<Model>((x) => x.posts.any((p) => p.score.gt(3)));
recordPredicate<Model>((x) => x.posts.all((p) => p.id.gt(0)));
recordPredicate<Model>((x) => x.posts.count().gte(2));
recordPredicate<Model>((x) => x.name.eq('a').and(x.id.lt(9)));

// ---- Illegal usage: each line MUST raise a type error ----

// numbers have no string operators
// @ts-expect-error
recordPredicate<Model>((x) => x.id.startsWith('1'));

// booleans are not ordered
// @ts-expect-error
recordPredicate<Model>((x) => x.isActive.gt(1));

// gt on a number requires a number argument
// @ts-expect-error
recordPredicate<Model>((x) => x.id.gt('nope'));

// collections expose any/all/count, not scalar operators
// @ts-expect-error
recordPredicate<Model>((x) => x.tags.eq('news'));

// @ts-expect-error
recordPredicate<Model>((x) => x.posts.startsWith('a'));

// scalar fields have no collection operators
// @ts-expect-error
recordPredicate<Model>((x) => x.name.count().gt(1));

// eq on a string requires a string argument
// @ts-expect-error
recordPredicate<Model>((x) => x.name.eq(5));

// a predicate must return a BoolExpr, never a raw boolean
// @ts-expect-error
recordPredicate<Model>((x) => x.isActive);
