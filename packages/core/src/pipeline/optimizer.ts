/**
 * Optimizer (plan §5 · S3, Phase 3): pure IR → IR simplification applied to a
 * predicate tree before SQL generation.
 *
 * Passes:
 *  - constant folding: a comparison/like/in/nullcheck over only constants folds
 *    to a boolean literal;
 *  - logical simplification: flatten nested and/or, drop identity literals,
 *    short-circuit on absorbing literals, collapse single-operand groups;
 *  - double-negation elimination and literal negation.
 *
 * `conjuncts()` flattens an AND tree into independent clauses — the enabling
 * step for predicate pushdown in the query pipeline (Phase 4).
 */
import type {
  BoolExprNode,
  ConstantExpr,
  LiteralBoolExpr,
  ValueExpr,
} from '../ir/nodes.js';

const TRUE: LiteralBoolExpr = { kind: 'lit', value: true };
const FALSE: LiteralBoolExpr = { kind: 'lit', value: false };
const lit = (value: boolean): LiteralBoolExpr => (value ? TRUE : FALSE);

function isConst(expr: ValueExpr): expr is ConstantExpr {
  return expr.kind === 'constant';
}

function compareConst(op: string, l: unknown, r: unknown): boolean {
  switch (op) {
    case 'eq':
      return l === r;
    case 'neq':
      return l !== r;
    case 'gt':
      return (l as never) > (r as never);
    case 'gte':
      return (l as never) >= (r as never);
    case 'lt':
      return (l as never) < (r as never);
    case 'lte':
      return (l as never) <= (r as never);
    default:
      return false;
  }
}

/** Optimize a predicate tree. Returns an equivalent, simplified tree. */
export function optimize(node: BoolExprNode): BoolExprNode {
  switch (node.kind) {
    case 'binary': {
      if (isConst(node.left) && isConst(node.right)) {
        return lit(compareConst(node.op, node.left.value, node.right.value));
      }
      return node;
    }
    case 'nullcheck': {
      if (isConst(node.target)) {
        const isNull = node.target.value === null || node.target.value === undefined;
        return lit(node.negated ? !isNull : isNull);
      }
      return node;
    }
    case 'in': {
      if (isConst(node.target)) {
        return lit(node.values.includes(node.target.value));
      }
      return node;
    }
    case 'not': {
      const inner = optimize(node.operand);
      if (inner.kind === 'lit') return lit(!inner.value);
      if (inner.kind === 'not') return inner.operand; // ¬¬x → x
      return { kind: 'not', operand: inner };
    }
    case 'logical':
      return optimizeLogical(node.op, node.operands.map(optimize));
    case 'exists': {
      if (node.predicate === undefined) return node;
      const predicate = optimize(node.predicate);
      // `any` over an always-false body can never match.
      if (node.mode === 'any' && predicate.kind === 'lit' && !predicate.value) return FALSE;
      return { kind: 'exists', navigation: node.navigation, mode: node.mode, predicate };
    }
    default:
      return node;
  }
}

function optimizeLogical(op: 'and' | 'or', operands: BoolExprNode[]): BoolExprNode {
  const identity = op === 'and';
  const kept: BoolExprNode[] = [];
  for (const operand of operands) {
    // Flatten nested groups of the same operator.
    if (operand.kind === 'logical' && operand.op === op) {
      kept.push(...operand.operands);
      continue;
    }
    if (operand.kind === 'lit') {
      if (operand.value === identity) continue; // drop `true` from AND / `false` from OR
      return lit(!identity); // absorbing element short-circuits the group
    }
    kept.push(operand);
  }
  if (kept.length === 0) return lit(identity);
  if (kept.length === 1) return kept[0]!;
  return { kind: 'logical', op, operands: kept };
}

/** Flatten a predicate into independent AND clauses (pushdown enabler). */
export function conjuncts(node: BoolExprNode): readonly BoolExprNode[] {
  if (node.kind === 'logical' && node.op === 'and') {
    return node.operands.flatMap(conjuncts);
  }
  return [node];
}
