/**
 * In-memory engine: the SQL generator serializes IR as JSON into `sql`,
 * and the executor evaluates it against in-process tables. This gives the
 * unit-test suite real query semantics with zero database.
 */
import type {
  BoolExprNode,
  CompiledCommand,
  ExecuteResult,
  GenContext,
  IQueryExecutor,
  ISqlGenerator,
  OrmEngine,
  Row,
  SelectExpr,
  ValueExpr,
  WriteOp,
} from '@ormit/core';
import { irHash, TranslationError } from '@ormit/core';

function resolve(expr: ValueExpr, row: Row): unknown {
  switch (expr.kind) {
    case 'constant':
      return expr.value;
    case 'column': {
      let value: unknown = row;
      for (const segment of expr.path) {
        if (typeof value !== 'object' || value === null) return undefined;
        value = (value as Row)[segment];
      }
      return value;
    }
    case 'function': {
      const arg = resolve(expr.args[0]!, row);
      if (typeof arg !== 'string') return arg;
      return expr.name === 'lower' ? arg.toLowerCase() : arg.toUpperCase();
    }
    case 'subaggregate':
      throw new TranslationError(
        'In-memory engine cannot evaluate a correlated subquery; normalize it first.',
      );
  }
}

function evaluate(node: BoolExprNode, row: Row): boolean {
  switch (node.kind) {
    case 'binary': {
      const l = resolve(node.left, row) as never;
      const r = resolve(node.right, row) as never;
      switch (node.op) {
        case 'eq': return l === r;
        case 'neq': return l !== r;
        case 'gt': return l > r;
        case 'gte': return l >= r;
        case 'lt': return l < r;
        case 'lte': return l <= r;
      }
      break;
    }
    case 'logical':
      return node.op === 'and'
        ? node.operands.every((n) => evaluate(n, row))
        : node.operands.some((n) => evaluate(n, row));
    case 'not':
      return !evaluate(node.operand, row);
    case 'nullcheck': {
      const v = resolve(node.target, row);
      const isNull = v === null || v === undefined;
      return node.negated ? !isNull : isNull;
    }
    case 'like': {
      const v = resolve(node.target, row);
      if (typeof v !== 'string') return false;
      if (node.mode === 'startsWith') return v.startsWith(node.value);
      if (node.mode === 'endsWith') return v.endsWith(node.value);
      return v.includes(node.value);
    }
    case 'in':
      return node.values.includes(resolve(node.target, row));
    case 'lit':
      return node.value;
    case 'exists':
      throw new TranslationError(
        'In-memory engine cannot evaluate EXISTS without normalization.',
      );
  }
  throw new TranslationError(`In-memory engine cannot evaluate node kind.`);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as never) < (b as never) ? -1 : 1;
}

function distinctRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function aggregateRows(
  spec: { fn: string; path?: readonly string[] },
  rows: Row[],
): number {
  if (spec.fn === 'count') return rows.length;
  const values = rows
    .map((r) => resolve({ kind: 'column', path: spec.path ?? [] }, r))
    .filter((v): v is number => typeof v === 'number');
  if (spec.fn === 'sum') return values.reduce((a, b) => a + b, 0);
  if (spec.fn === 'avg') return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  if (spec.fn === 'min') return values.length ? Math.min(...values) : 0;
  return values.length ? Math.max(...values) : 0; // max
}

type Payload =
  | { readonly type: 'select'; readonly query: SelectExpr; readonly table: string }
  | { readonly type: 'write'; readonly op: WriteOp; readonly table: string };

export class InMemoryEngine implements OrmEngine {
  private readonly tables = new Map<string, Row[]>();
  private readonly counters = new Map<string, number>();
  /** Log of executed commands, for assertions. */
  readonly log: CompiledCommand[] = [];

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, rows.map((r) => ({ ...r })));
  }
  rows(table: string): readonly Row[] {
    return this.tables.get(table) ?? [];
  }

  readonly generator: ISqlGenerator = {
    compileSelect: (query: SelectExpr, ctx: GenContext): CompiledCommand => {
      const table = ctx.tables.get(query.entity) ?? query.entity.toLowerCase() + 's';
      const payload: Payload = { type: 'select', query, table };
      return { sql: JSON.stringify(payload), params: [], irHash: irHash(query) };
    },
    compileWrite: (op: WriteOp, ctx: GenContext): CompiledCommand => {
      const table = ctx.tables.get(op.entity) ?? op.entity.toLowerCase() + 's';
      const payload: Payload = { type: 'write', op, table };
      return { sql: JSON.stringify(payload), params: [], irHash: irHash(op) };
    },
    compileRaw: (): CompiledCommand => {
      throw new TranslationError(
        'The in-memory engine does not support fromSql(); use a real dialect (e.g. @ormit/sqlite).',
      );
    },
  };

  readonly executor: IQueryExecutor = {
    capabilities: {
      returningStrategy: 'returning',
      ddlInTransaction: true,
      savepoints: true,
      maxParams: 999,
      upsertSyntax: 'onConflict',
      ilike: false,
      paging: 'limitOffset',
    },
    query: async (cmd: CompiledCommand): Promise<readonly Row[]> => {
      this.log.push(cmd);
      const payload = JSON.parse(cmd.sql) as Payload;
      if (payload.type !== 'select') throw new TranslationError('query() requires a select.');
      const { query, table } = payload;
      let rows = [...(this.tables.get(table) ?? [])];
      if (query.predicate) rows = rows.filter((r) => evaluate(query.predicate!, r));
      if (query.aggregate) {
        const base = query.distinct ? distinctRows(rows) : rows;
        return [{ value: aggregateRows(query.aggregate, base) }];
      }
      for (const ordering of [...query.orderings].reverse()) {
        rows.sort((a, b) => {
          const av = resolve({ kind: 'column', path: ordering.path }, a);
          const bv = resolve({ kind: 'column', path: ordering.path }, b);
          return ordering.direction === 'asc' ? compare(av, bv) : compare(bv, av);
        });
      }
      if (query.projection) {
        const entries = Object.entries(query.projection);
        rows = rows.map((r) =>
          Object.fromEntries(entries.map(([alias, path]) => [alias, resolve({ kind: 'column', path }, r)])),
        );
      }
      if (query.distinct) rows = distinctRows(rows);
      if (query.skip !== undefined) rows = rows.slice(query.skip);
      if (query.take !== undefined) rows = rows.slice(0, query.take);
      return rows.map((r) => ({ ...r }));
    },
    execute: async (cmd: CompiledCommand): Promise<ExecuteResult> => {
      this.log.push(cmd);
      const payload = JSON.parse(cmd.sql) as Payload;
      if (payload.type !== 'write') throw new TranslationError('execute() requires a write.');
      const { op, table } = payload;
      const rows = this.tables.get(table) ?? [];
      this.tables.set(table, rows);
      switch (op.kind) {
        case 'insert': {
          const next = (this.counters.get(table) ?? rows.length) + 1;
          this.counters.set(table, next);
          const inserted: Row = { id: next, ...op.values };
          rows.push(inserted);
          return { affected: 1, returning: [{ ...inserted }] };
        }
        case 'update': {
          let affected = 0;
          for (const row of rows) {
            if (evaluate(op.predicate, row)) {
              Object.assign(row, op.values);
              affected++;
            }
          }
          return { affected };
        }
        case 'delete': {
          const keep = rows.filter((r) => !evaluate(op.predicate, r));
          const affected = rows.length - keep.length;
          this.tables.set(table, keep);
          return { affected };
        }
      }
    },
    transaction: async <T>(work: () => Promise<T>): Promise<T> => {
      // Snapshot state so a thrown error rolls the whole unit of work back.
      const tables = new Map([...this.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
      const counters = new Map(this.counters);
      try {
        return await work();
      } catch (error) {
        this.tables.clear();
        for (const [k, v] of tables) this.tables.set(k, v);
        this.counters.clear();
        for (const [k, v] of counters) this.counters.set(k, v);
        throw error;
      }
    },
  };
}
