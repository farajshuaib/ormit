/**
 * The internal expression IR — a small, closed algebra (plan S1).
 * Nodes are immutable plain objects; the structural hash is the cache key.
 */

export type ComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface ColumnExpr {
  readonly kind: 'column';
  readonly path: readonly string[];
}
export interface ConstantExpr {
  readonly kind: 'constant';
  readonly value: unknown;
}
/** A scalar function over other value expressions (e.g. lower/upper). */
export interface FunctionCallExpr {
  readonly kind: 'function';
  readonly name: 'lower' | 'upper';
  readonly args: readonly ValueExpr[];
}
/** A correlated scalar aggregate over a collection navigation (e.g. count). */
export interface SubAggregateExpr {
  readonly kind: 'subaggregate';
  readonly fn: 'count';
  readonly navigation: readonly string[];
}
export type ValueExpr = ColumnExpr | ConstantExpr | FunctionCallExpr | SubAggregateExpr;

export interface BinaryExpr {
  readonly kind: 'binary';
  readonly op: ComparisonOp;
  readonly left: ValueExpr;
  readonly right: ValueExpr;
}
export interface LogicalExpr {
  readonly kind: 'logical';
  readonly op: 'and' | 'or';
  readonly operands: readonly BoolExprNode[];
}
export interface NotExpr {
  readonly kind: 'not';
  readonly operand: BoolExprNode;
}
export interface NullCheckExpr {
  readonly kind: 'nullcheck';
  readonly target: ValueExpr;
  readonly negated: boolean;
}
export interface LikeExpr {
  readonly kind: 'like';
  readonly target: ValueExpr;
  /** `raw` uses `value` as a full LIKE pattern; the others wrap with `%`. */
  readonly mode: 'startsWith' | 'endsWith' | 'contains' | 'raw';
  readonly value: string;
}
export interface InExpr {
  readonly kind: 'in';
  readonly target: ValueExpr;
  readonly values: readonly unknown[];
}
/** A folded boolean literal, produced by the optimizer (`WHERE true/false`). */
export interface LiteralBoolExpr {
  readonly kind: 'lit';
  readonly value: boolean;
}
/** EXISTS/ALL over a collection navigation. `mode:'all'` compiles to
 * `NOT EXISTS(… WHERE NOT predicate)`; a missing predicate means "any row". */
export interface ExistsExpr {
  readonly kind: 'exists';
  readonly navigation: readonly string[];
  readonly mode: 'any' | 'all';
  readonly predicate?: BoolExprNode;
}
export type BoolExprNode =
  | BinaryExpr
  | LogicalExpr
  | NotExpr
  | NullCheckExpr
  | LikeExpr
  | InExpr
  | ExistsExpr
  | LiteralBoolExpr;

export interface Ordering {
  readonly path: readonly string[];
  readonly direction: 'asc' | 'desc';
}

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** A scalar aggregate terminal over the result set. `count` needs no path. */
export interface AggregateSpec {
  readonly fn: AggregateFn;
  readonly path?: readonly string[];
}

/** An eager-loading directive over a navigation (Include/ThenInclude). Loaded
 * as split queries by default (ADR-003); `children` are ThenIncludes. */
export interface IncludeNode {
  readonly navigation: string;
  readonly target: string;
  readonly collection: boolean;
  readonly foreignKey: readonly string[];
  readonly principalKey: readonly string[];
  readonly filter?: BoolExprNode;
  readonly children: readonly IncludeNode[];
}

/** Root query node. Projection maps output alias -> column path. */
export interface SelectExpr {
  readonly kind: 'select';
  readonly entity: string;
  readonly predicate?: BoolExprNode;
  readonly orderings: readonly Ordering[];
  readonly skip?: number;
  readonly take?: number;
  readonly projection?: Readonly<Record<string, readonly string[]>>;
  readonly distinct?: boolean;
  readonly aggregate?: AggregateSpec;
  readonly includes?: readonly IncludeNode[];
}

// ---- Write operations (unit of work) ----
export interface InsertOp {
  readonly kind: 'insert';
  readonly entity: string;
  readonly values: Readonly<Record<string, unknown>>;
}
export interface UpdateOp {
  readonly kind: 'update';
  readonly entity: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly predicate: BoolExprNode;
}
export interface DeleteOp {
  readonly kind: 'delete';
  readonly entity: string;
  readonly predicate: BoolExprNode;
}
export type WriteOp = InsertOp | UpdateOp | DeleteOp;
