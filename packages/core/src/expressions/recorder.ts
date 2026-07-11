/**
 * Expression recorder (ADR-001).
 *
 * `where(x => x.age.gt(18))` invokes the lambda ONCE at build time with a
 * Proxy-based EntityRef<T>. Property access yields typed FieldRefs; operator
 * methods return IR nodes. The lambda's return value IS the tree — no source
 * parsing, minification-safe.
 *
 * Operators are built over a `ValueExpr` rather than a bare path, so results of
 * `toLower()`/`toUpper()` (function calls) and `count()` (a correlated
 * subquery) remain fully chainable comparables.
 */
import type {
  BoolExprNode,
  ColumnExpr,
  ComparisonOp,
  FunctionCallExpr,
  ValueExpr,
} from '../ir/nodes.js';
import { TranslationError } from '../errors.js';

// ---------- Public value-side types ----------

/** A boolean expression that supports logical composition. */
export interface BoolExpr {
  readonly node: BoolExprNode;
  and(other: BoolExpr): BoolExpr;
  or(other: BoolExpr): BoolExpr;
  not(): BoolExpr;
}

export interface FieldOps<V> {
  eq(value: V | FieldRefOf<V>): BoolExpr;
  neq(value: V | FieldRefOf<V>): BoolExpr;
  in(values: readonly V[]): BoolExpr;
  isNull(): BoolExpr;
  isNotNull(): BoolExpr;
}
export interface OrderedOps<V> extends FieldOps<V> {
  gt(value: V | FieldRefOf<V>): BoolExpr;
  gte(value: V | FieldRefOf<V>): BoolExpr;
  lt(value: V | FieldRefOf<V>): BoolExpr;
  lte(value: V | FieldRefOf<V>): BoolExpr;
  between(low: V, high: V): BoolExpr;
}
export interface StringOps extends OrderedOps<string> {
  startsWith(value: string): BoolExpr;
  endsWith(value: string): BoolExpr;
  contains(value: string): BoolExpr;
  like(pattern: string): BoolExpr;
  toLower(): StringOps;
  toUpper(): StringOps;
}
/** Operators on a to-many navigation → subquery / EXISTS. */
export interface CollectionOps<E> {
  any(predicate?: (x: EntityRef<E>) => BoolExpr): BoolExpr;
  all(predicate: (x: EntityRef<E>) => BoolExpr): BoolExpr;
  count(): OrderedOps<number>;
}

/** Maps a property type to its FieldRef flavor (drives IntelliSense). */
export type FieldRefOf<V> = [NonNullable<V>] extends [ReadonlyArray<infer E>]
  ? CollectionOps<E extends object ? E : never>
  : [NonNullable<V>] extends [string]
    ? StringOps
    : [NonNullable<V>] extends [number | Date | bigint]
      ? OrderedOps<NonNullable<V>>
      : [NonNullable<V>] extends [boolean]
        ? FieldOps<NonNullable<V>>
        : NonNullable<V> extends object
          ? EntityRef<NonNullable<V>> // nested path (owned types)
          : FieldOps<NonNullable<V>>;

/** What the lambda parameter looks like: every property is a typed FieldRef. */
export type EntityRef<T> = { readonly [K in keyof T]-?: FieldRefOf<T[K]> };

// ---------- Internals ----------

const PATH = Symbol('ormit.path');
const EXPR = Symbol('ormit.expr');

interface Carrier {
  [PATH]?: readonly string[];
  [EXPR]: ValueExpr;
}

function isCarrier(v: unknown): v is Carrier {
  return typeof v === 'object' && v !== null && EXPR in v;
}
function toValueExpr(v: unknown): ValueExpr {
  return isCarrier(v) ? v[EXPR] : { kind: 'constant', value: v };
}
function column(path: readonly string[]): ColumnExpr {
  return { kind: 'column', path };
}
function pathOf(expr: ValueExpr): readonly string[] {
  return expr.kind === 'column' ? expr.path : [];
}

function bool(node: BoolExprNode): BoolExpr {
  return {
    node,
    and: (o) => bool({ kind: 'logical', op: 'and', operands: [node, o.node] }),
    or: (o) => bool({ kind: 'logical', op: 'or', operands: [node, o.node] }),
    not: () => bool({ kind: 'not', operand: node }),
  };
}

const COMPARISONS = new Set<ComparisonOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

function operatorFor(expr: ValueExpr, name: string): unknown {
  if (COMPARISONS.has(name as ComparisonOp)) {
    return (value: unknown): BoolExpr =>
      bool({ kind: 'binary', op: name as ComparisonOp, left: expr, right: toValueExpr(value) });
  }
  switch (name) {
    case 'between':
      return (low: unknown, high: unknown) =>
        bool({ kind: 'binary', op: 'gte', left: expr, right: toValueExpr(low) }).and(
          bool({ kind: 'binary', op: 'lte', left: expr, right: toValueExpr(high) }),
        );
    case 'in':
      return (values: readonly unknown[]) =>
        bool({ kind: 'in', target: expr, values: [...values] });
    case 'isNull':
      return () => bool({ kind: 'nullcheck', target: expr, negated: false });
    case 'isNotNull':
      return () => bool({ kind: 'nullcheck', target: expr, negated: true });
    case 'startsWith':
    case 'endsWith':
    case 'contains':
      return (value: string) => bool({ kind: 'like', target: expr, mode: name, value });
    case 'like':
      return (pattern: string) => bool({ kind: 'like', target: expr, mode: 'raw', value: pattern });
    case 'toLower':
      return () => makeValue(fn('lower', expr));
    case 'toUpper':
      return () => makeValue(fn('upper', expr));
    case 'count':
      return () => makeValue({ kind: 'subaggregate', fn: 'count', navigation: pathOf(expr) });
    case 'any':
      return (predicate?: SubPredicate) =>
        bool({
          kind: 'exists',
          navigation: pathOf(expr),
          mode: 'any',
          ...(predicate ? { predicate: recordSubPredicate(predicate) } : {}),
        });
    case 'all':
      return (predicate: SubPredicate) =>
        bool({
          kind: 'exists',
          navigation: pathOf(expr),
          mode: 'all',
          predicate: recordSubPredicate(predicate),
        });
    default:
      return undefined;
  }
}

function fn(name: FunctionCallExpr['name'], arg: ValueExpr): FunctionCallExpr {
  return { kind: 'function', name, args: [arg] };
}

/** Proxy over a value expression; `descend` (when given) treats unknown
 * members as nested property-path access. */
function exprProxy(expr: ValueExpr, descend?: (prop: string) => unknown): unknown {
  return new Proxy(Object.create(null) as object, {
    get(_t, prop) {
      if (prop === EXPR) return expr;
      if (prop === PATH) return expr.kind === 'column' ? expr.path : undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined; // avoid thenable trap in async code
      const op = operatorFor(expr, prop);
      if (op !== undefined) return op;
      return descend ? descend(prop) : undefined;
    },
    has: (_t, prop) => prop === EXPR || prop === PATH || typeof prop === 'string',
  });
}

/** A path ref: operators plus nested property descent. */
function makeRef(path: readonly string[]): unknown {
  return exprProxy(column(path), (prop) => makeRef([...path, prop]));
}
/** A computed value ref: operators only (no path descent). */
function makeValue(expr: ValueExpr): unknown {
  return exprProxy(expr);
}

/** Create the proxy handed to `where`/`orderBy`/`select` lambdas. */
export function createEntityRef<T>(): EntityRef<T> {
  return makeRef([]) as EntityRef<T>;
}

/** Extract a pure property path from a selector lambda (orderBy/include). */
export function recordPath<T>(selector: (x: EntityRef<T>) => unknown): readonly string[] {
  const result = selector(createEntityRef<T>());
  if (!isCarrier(result) || result[PATH] === undefined) {
    throw new TranslationError(
      'Selector must return a property path (e.g. x => x.name); ' +
        'computed values are not translatable.',
    );
  }
  const path = result[PATH];
  if (path.length === 0) {
    throw new TranslationError('Selector must access at least one property.');
  }
  return path;
}

/** Record a `select` projection: an object literal of field paths → alias map. */
export function recordProjection<T>(
  projector: (x: EntityRef<T>) => Record<string, unknown>,
): Record<string, readonly string[]> {
  const shape = projector(createEntityRef<T>());
  if (typeof shape !== 'object' || shape === null || Array.isArray(shape)) {
    throw new TranslationError(
      'select() must return an object of fields, e.g. x => ({ id: x.id, name: x.name }).',
    );
  }
  const out: Record<string, readonly string[]> = {};
  for (const [alias, ref] of Object.entries(shape)) {
    if (!isCarrier(ref) || ref[PATH] === undefined || ref[PATH].length === 0) {
      throw new TranslationError(
        `Projection field '${alias}' must be a property path (e.g. x.${alias}); ` +
          'computed values are not translatable.',
      );
    }
    out[alias] = ref[PATH];
  }
  return out;
}

/** Run a predicate lambda and return its IR node. */
export function recordPredicate<T>(predicate: (x: EntityRef<T>) => BoolExpr): BoolExprNode {
  const result = predicate(createEntityRef<T>());
  if (typeof result !== 'object' || result === null || !('node' in result)) {
    throw new TranslationError(
      'Predicate must return a BoolExpr built from field operators ' +
        '(e.g. x => x.age.gt(18)); plain booleans are not translatable.',
    );
  }
  return result.node;
}

/** The element-level predicate accepted by `any`/`all` (internally untyped). */
type SubPredicate = (x: EntityRef<never>) => BoolExpr;

/** Record a nested predicate (the body of `any`/`all`) against the element. */
function recordSubPredicate(predicate: SubPredicate): BoolExprNode {
  return recordPredicate(predicate as (x: EntityRef<unknown>) => BoolExpr);
}
