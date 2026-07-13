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
import type { ValueConverter, ValueConverterRegistry } from '../metadata/converters.js';

export interface NormalizeOptions {
  readonly ignoreQueryFilters?: boolean;
}

/** Run the full normalization pipeline over a select. */
export function normalize(
  select: SelectExpr,
  snapshot: ModelSnapshot,
  options: NormalizeOptions = {},
  converters?: ValueConverterRegistry,
): SelectExpr {
  const withFilters = options.ignoreQueryFilters
    ? select
    : injectQueryFilters(select, snapshot);
  return resolveColumns(withFilters, snapshot, converters);
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
export function resolveColumns(
  select: SelectExpr,
  snapshot: ModelSnapshot,
  converters?: ValueConverterRegistry,
): SelectExpr {
  const entity = snapshot.entity(select.entity);
  if (!entity) return select;

  const predicate = select.predicate
    ? resolvePredicate(select.predicate, entity, snapshot, converters)
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
  converters?: ValueConverterRegistry,
): BoolExprNode {
  switch (node.kind) {
    case 'binary': {
      // A constant compared against a converted column is run through the
      // converter, so `where(x => x.status.eq(Status.Active))` filters with the
      // stored representation.
      const left = convertConstant(node.left, node.right, entity, snapshot, converters);
      const right = convertConstant(node.right, node.left, entity, snapshot, converters);
      return {
        kind: 'binary',
        op: node.op,
        left: resolveValue(left, entity, snapshot),
        right: resolveValue(right, entity, snapshot),
      };
    }
    case 'logical':
      return {
        kind: 'logical',
        op: node.op,
        operands: node.operands.map((n) => resolvePredicate(n, entity, snapshot, converters)),
      };
    case 'not':
      return { kind: 'not', operand: resolvePredicate(node.operand, entity, snapshot, converters) };
    case 'nullcheck':
      return { ...node, target: resolveValue(node.target, entity, snapshot) };
    case 'like':
      return { ...node, target: resolveValue(node.target, entity, snapshot) };
    case 'in': {
      const converter =
        node.target.kind === 'column'
          ? converterForPath(node.target.path, entity, snapshot, converters)
          : undefined;
      const values = converter
        ? node.values.map((v) => (v === null || v === undefined ? v : converter.toProvider(v)))
        : node.values;
      return { ...node, target: resolveValue(node.target, entity, snapshot), values };
    }
    case 'exists': {
      const nav = entity.navigations.find((n) => n.name === node.navigation[0]);
      const child = nav ? snapshot.entity(nav.target) : null;
      if (!child || node.predicate === undefined) return node;
      return { ...node, predicate: resolvePredicate(node.predicate, child, snapshot, converters) };
    }
    case 'lit':
      return node;
  }
}

/**
 * If `expr` is a constant and `against` is a column mapping to a converted
 * property, return the constant with its value run through `toProvider`;
 * otherwise return `expr` unchanged.
 */
function convertConstant(
  expr: ValueExpr,
  against: ValueExpr,
  entity: EntitySnapshot,
  snapshot: ModelSnapshot,
  converters: ValueConverterRegistry | undefined,
): ValueExpr {
  if (expr.kind !== 'constant' || against.kind !== 'column') return expr;
  if (expr.value === null || expr.value === undefined) return expr;
  const converter = converterForPath(against.path, entity, snapshot, converters);
  return converter ? { kind: 'constant', value: converter.toProvider(expr.value) } : expr;
}

/** Resolve the converter for a column path (following owned navigations), if any. */
function converterForPath(
  path: readonly string[],
  entity: EntitySnapshot,
  snapshot: ModelSnapshot,
  converters: ValueConverterRegistry | undefined,
): ValueConverter | undefined {
  if (!converters || converters.size === 0 || path.length === 0) return undefined;
  let cur: EntitySnapshot = entity;
  let i = 0;
  while (i < path.length - 1) {
    const nav = cur.navigations.find((n) => n.name === path[i]);
    if (nav && nav.owned && !nav.collection) {
      const target = snapshot.entity(nav.target);
      if (!target) return undefined;
      cur = target;
      i++;
    } else {
      return undefined;
    }
  }
  const prop = cur.properties.find((p) => p.name === path[i]);
  return prop?.conversion ? converters.get(prop.conversion) : undefined;
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
