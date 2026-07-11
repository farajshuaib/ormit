/**
 * Normalizer (plan §5 · S3, Phase 3): metadata-aware IR → IR passes that run
 * before optimization and SQL generation.
 *
 * Passes:
 *  - inject query filters: AND each entity's stored global filter into the
 *    predicate, unless the query opted out with `ignoreQueryFilters`;
 *  - resolve column paths: rewrite paths through *owned* navigations and paths
 *    with column-name overrides into their physical column, leaving paths
 *    through regular navigations for the join layer (Phase 4).
 *
 * Resolution is lenient: a path the metadata doesn't map (a scalar the user
 * never configured, common without decorators) is left unchanged rather than
 * rejected, so it maps to an identically-named column.
 */
import type {
  BoolExprNode,
  SelectExpr,
  ValueExpr,
} from '../ir/nodes.js';
import type { ModelSnapshot } from '../metadata/snapshot.js';
import type { EntitySnapshot } from '../metadata/types.js';

export interface NormalizeOptions {
  readonly ignoreQueryFilters?: boolean;
}

/** Run the full normalization pipeline over a select. */
export function normalize(
  select: SelectExpr,
  snapshot: ModelSnapshot,
  options: NormalizeOptions = {},
): SelectExpr {
  const withFilters = options.ignoreQueryFilters
    ? select
    : injectQueryFilters(select, snapshot);
  return resolveColumns(withFilters, snapshot);
}

/** AND the entity's stored query filter into the predicate. */
export function injectQueryFilters(select: SelectExpr, snapshot: ModelSnapshot): SelectExpr {
  const entity = snapshot.entity(select.entity);
  const filter = entity?.queryFilter;
  if (filter === null || filter === undefined) return select;
  const filterNode = filter as unknown as BoolExprNode;
  const predicate: BoolExprNode = select.predicate
    ? { kind: 'logical', op: 'and', operands: [filterNode, select.predicate] }
    : filterNode;
  return { ...select, predicate };
}

/** Rewrite owned/override column paths to physical columns throughout a select. */
export function resolveColumns(select: SelectExpr, snapshot: ModelSnapshot): SelectExpr {
  const entity = snapshot.entity(select.entity);
  if (!entity) return select;

  const predicate = select.predicate
    ? resolvePredicate(select.predicate, entity, snapshot)
    : undefined;

  const orderings = select.orderings.map((o) => ({
    ...o,
    path: resolveColumnPath(o.path, entity, snapshot),
  }));

  let projection = select.projection;
  if (projection) {
    projection = Object.fromEntries(
      Object.entries(projection).map(([alias, path]) => [
        alias,
        resolveColumnPath(path, entity, snapshot),
      ]),
    );
  }

  return {
    ...select,
    ...(predicate ? { predicate } : {}),
    orderings,
    ...(projection ? { projection } : {}),
  };
}

/** Resolve one column path against an entity, following owned navigations. */
export function resolveColumnPath(
  path: readonly string[],
  entity: EntitySnapshot,
  snapshot: ModelSnapshot,
): readonly string[] {
  if (path.length === 0) return path;
  let cur: EntitySnapshot = entity;
  let i = 0;
  while (i < path.length - 1) {
    const nav = cur.navigations.find((n) => n.name === path[i]);
    if (nav && nav.owned && !nav.collection) {
      const target = snapshot.entity(nav.target);
      if (!target) return path;
      cur = target;
      i++;
    } else {
      return path; // regular navigation or unknown segment → leave for joins
    }
  }
  const prop = cur.properties.find((p) => p.name === path[i]);
  return prop ? [prop.column] : path;
}

function resolvePredicate(
  node: BoolExprNode,
  entity: EntitySnapshot,
  snapshot: ModelSnapshot,
): BoolExprNode {
  switch (node.kind) {
    case 'binary':
      return {
        kind: 'binary',
        op: node.op,
        left: resolveValue(node.left, entity, snapshot),
        right: resolveValue(node.right, entity, snapshot),
      };
    case 'logical':
      return {
        kind: 'logical',
        op: node.op,
        operands: node.operands.map((n) => resolvePredicate(n, entity, snapshot)),
      };
    case 'not':
      return { kind: 'not', operand: resolvePredicate(node.operand, entity, snapshot) };
    case 'nullcheck':
      return { ...node, target: resolveValue(node.target, entity, snapshot) };
    case 'like':
      return { ...node, target: resolveValue(node.target, entity, snapshot) };
    case 'in':
      return { ...node, target: resolveValue(node.target, entity, snapshot) };
    case 'exists': {
      const nav = entity.navigations.find((n) => n.name === node.navigation[0]);
      const child = nav ? snapshot.entity(nav.target) : null;
      if (!child || node.predicate === undefined) return node;
      return { ...node, predicate: resolvePredicate(node.predicate, child, snapshot) };
    }
    case 'lit':
      return node;
  }
}

function resolveValue(
  expr: ValueExpr,
  entity: EntitySnapshot,
  snapshot: ModelSnapshot,
): ValueExpr {
  switch (expr.kind) {
    case 'column':
      return { kind: 'column', path: resolveColumnPath(expr.path, entity, snapshot) };
    case 'function':
      return {
        kind: 'function',
        name: expr.name,
        args: expr.args.map((a) => resolveValue(a, entity, snapshot)),
      };
    case 'constant':
    case 'subaggregate':
      return expr;
  }
}
