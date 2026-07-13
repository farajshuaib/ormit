/**
 * Type-level gate: `thenBy`/`thenByDescending` are only reachable after an
 * `orderBy`/`orderByDescending` (they live on `OrderedQueryable`, EF Core's
 * `IOrderedQueryable`). A `thenBy` on a plain `Queryable` must not type-check.
 *
 * Run via `pnpm test:types`.
 */
import type { Queryable, OrderedQueryable } from '../src/index.js';

interface Model {
  id: number;
  name: string;
  age: number;
}

declare const q: Queryable<Model>;

// ---- Legal: thenBy chains after an orderBy ----
const ordered: OrderedQueryable<Model> = q.orderBy((x) => x.age);
ordered.thenBy((x) => x.name);
ordered.thenByDescending((x) => x.name);
q.orderByDescending((x) => x.age).thenBy((x) => x.name).thenByDescending((x) => x.id);

// ---- Illegal: thenBy without a prior orderBy ----
// @ts-expect-error — thenBy is not on a plain Queryable
q.thenBy((x) => x.name);
// @ts-expect-error — thenByDescending is not on a plain Queryable
q.thenByDescending((x) => x.name);
