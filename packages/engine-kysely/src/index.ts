/**
 * Kysely engine (ADR-002): lowers Ormit IR onto Kysely's query builder and
 * lets Kysely's per-dialect compilers produce { sql, params }.
 *
 * NOTE ON TYPES: Kysely's generics assume a statically-known schema. Ormit
 * drives Kysely *dynamically* from IR, so this module contains the single
 * sanctioned `any` boundary in the workspace (risk R2 in the plan). Nothing
 * here leaks into public types — the exported surface is fully typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  DummyDriver,
  Kysely,
  MssqlAdapter,
  MssqlIntrospector,
  MssqlQueryCompiler,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type CompiledQuery,
} from 'kysely';
import {
  irHash,
  TranslationError,
  type BoolExprNode,
  type ColumnDef,
  type CompiledCommand,
  type GenContext,
  type ISqlGenerator,
  type MigrationOperation,
  type SelectExpr,
  type ValueExpr,
  type WriteOp,
} from '@ormit/core';

export type SupportedDialect = 'postgres' | 'sqlite' | 'mysql' | 'mssql';

type AnyKysely = Kysely<any>;
type AnyEb = any; // ExpressionBuilder over a dynamic schema — see module note.

interface DialectParts {
  adapter: () => unknown;
  introspector: (db: AnyKysely) => unknown;
  compiler: () => unknown;
}

const DIALECTS: Record<SupportedDialect, DialectParts> = {
  postgres: {
    adapter: () => new PostgresAdapter(),
    introspector: (db) => new PostgresIntrospector(db),
    compiler: () => new PostgresQueryCompiler(),
  },
  sqlite: {
    adapter: () => new SqliteAdapter(),
    introspector: (db) => new SqliteIntrospector(db),
    compiler: () => new SqliteQueryCompiler(),
  },
  mysql: {
    adapter: () => new MysqlAdapter(),
    introspector: (db) => new MysqlIntrospector(db),
    compiler: () => new MysqlQueryCompiler(),
  },
  mssql: {
    adapter: () => new MssqlAdapter(),
    introspector: (db) => new MssqlIntrospector(db),
    compiler: () => new MssqlQueryCompiler(),
  },
};

function compileOnlyKysely(dialect: SupportedDialect): AnyKysely {
  const parts = DIALECTS[dialect];
  return new Kysely<any>({
    dialect: {
      createAdapter: () => parts.adapter() as any,
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => parts.introspector(db) as any,
      createQueryCompiler: () => parts.compiler() as any,
    },
  });
}

/** Owned-type flattening convention: ['address','city'] -> address_city. */
const pathToRef = (path: readonly string[]): string => path.join('_');

function value(expr: ValueExpr, eb: AnyEb): unknown {
  switch (expr.kind) {
    case 'column':
      return eb.ref(pathToRef(expr.path));
    case 'constant':
      return expr.value;
    case 'function':
      return eb.fn(expr.name, [value(expr.args[0]!, eb)]);
    case 'subaggregate':
      // Correlated subqueries are lowered by the query pipeline (Phase 4),
      // not by the leaf value compiler.
      throw new TranslationError('Correlated subquery must be normalized before lowering.');
  }
}

/** Map a column definition to a Kysely data-type token. Keys default to
 * integer so a conventional `id` auto-increments even when its type is unknown. */
function dataType(col: ColumnDef, isPrimaryKey: boolean): string {
  switch (col.type) {
    case 'string':
      return col.maxLength ? `varchar(${col.maxLength})` : 'text';
    case 'number':
      return 'integer';
    case 'boolean':
      return 'integer';
    case 'Date':
      return 'timestamp';
    case 'bigint':
      return 'bigint';
    default:
      return isPrimaryKey ? 'integer' : 'text';
  }
}

function isAutoIncrementType(col: ColumnDef): boolean {
  return col.type === 'number' || col.type === 'bigint' || col.type === 'unknown';
}

function columnMods(c: any, col: ColumnDef, isPrimaryKey: boolean): any {
  let builder = c;
  if (isPrimaryKey) {
    builder = builder.primaryKey();
    if (isAutoIncrementType(col)) builder = builder.autoIncrement();
    return builder; // primary keys are implicitly NOT NULL
  }
  if (!col.nullable) builder = builder.notNull();
  if (col.defaultValueSql) builder = builder.defaultTo(sql.raw(col.defaultValueSql));
  else if (col.defaultValue !== null && col.defaultValue !== undefined) {
    builder = builder.defaultTo(col.defaultValue);
  }
  return builder;
}

function aggregate(spec: { fn: string; path?: readonly string[] }, eb: AnyEb): any {
  if (spec.fn === 'count') return eb.fn.countAll();
  const ref = eb.ref(pathToRef(spec.path ?? []));
  return eb.fn(spec.fn, [ref]);
}

function lower(node: BoolExprNode, eb: AnyEb): any {
  switch (node.kind) {
    case 'binary': {
      const ops = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
      return eb(value(node.left, eb), ops[node.op], value(node.right, eb));
    }
    case 'logical': {
      const parts = node.operands.map((n) => lower(n, eb));
      return node.op === 'and' ? eb.and(parts) : eb.or(parts);
    }
    case 'not':
      return eb.not(lower(node.operand, eb));
    case 'nullcheck':
      return eb(value(node.target, eb), node.negated ? 'is not' : 'is', null);
    case 'like': {
      const pattern =
        node.mode === 'startsWith' ? `${node.value}%` :
        node.mode === 'endsWith' ? `%${node.value}` :
        node.mode === 'raw' ? node.value : `%${node.value}%`;
      return eb(value(node.target, eb), 'like', pattern);
    }
    case 'in':
      return eb(value(node.target, eb), 'in', [...node.values]);
    case 'lit':
      return eb.lit(node.value);
    case 'exists':
      // EXISTS/ALL over a navigation is expanded by the query pipeline
      // (Phase 4) into a correlated subquery before it reaches the generator.
      throw new TranslationError('EXISTS over a navigation must be normalized before lowering.');
    default:
      throw new TranslationError('Unsupported IR node for Kysely lowering.');
  }
}

/** Dialects whose INSERT supports a `RETURNING` clause. */
const RETURNING_DIALECTS = new Set<SupportedDialect>(['postgres', 'sqlite']);

export class KyselySqlGenerator implements ISqlGenerator {
  private readonly db: AnyKysely;
  private readonly supportsReturning: boolean;
  constructor(private readonly dialect: SupportedDialect = 'postgres') {
    this.db = compileOnlyKysely(dialect);
    this.supportsReturning = RETURNING_DIALECTS.has(dialect);
  }

  private toCommand(compiled: CompiledQuery, hash: string): CompiledCommand {
    return { sql: compiled.sql, params: compiled.parameters, irHash: hash };
  }

  private table(entity: string, ctx: GenContext): string {
    const table = ctx.tables.get(entity);
    if (!table) throw new TranslationError(`No table mapping for entity '${entity}'.`);
    return table;
  }

  compileSelect(query: SelectExpr, ctx: GenContext): CompiledCommand {
    const from: any = this.db.selectFrom(this.table(query.entity, ctx));
    let sel: any = query.aggregate
      ? from.select((eb: AnyEb) => aggregate(query.aggregate!, eb).as('value'))
      : query.projection
        ? from.select(
            Object.entries(query.projection).map(([alias, path]) => `${pathToRef(path)} as ${alias}`),
          )
        : from.selectAll();

    if (query.distinct) sel = sel.distinct();
    if (query.predicate) sel = sel.where((eb: AnyEb) => lower(query.predicate!, eb));
    // Aggregates collapse the result set; ordering/paging over them is moot.
    if (!query.aggregate) {
      for (const o of query.orderings) sel = sel.orderBy(pathToRef(o.path), o.direction);
      if (query.take !== undefined) sel = sel.limit(query.take);
      if (query.skip !== undefined) sel = sel.offset(query.skip);
    }

    return this.toCommand(sel.compile(), irHash(query));
  }

  compileDdl(op: MigrationOperation, _ctx: GenContext): CompiledCommand[] {
    const schema: any = this.db.schema;
    switch (op.kind) {
      case 'createTable': {
        const singlePk = op.primaryKey.length === 1 ? op.primaryKey[0] : null;
        let builder = schema.createTable(op.table);
        for (const col of op.columns) {
          const isPk = col.name === singlePk;
          builder = builder.addColumn(col.name, dataType(col, isPk), (c: any) =>
            columnMods(c, col, isPk),
          );
        }
        if (op.primaryKey.length > 1) {
          builder = builder.addPrimaryKeyConstraint(`pk_${op.table}`, [...op.primaryKey]);
        }
        return [this.toCommand(builder.compile(), irHash(op))];
      }
      case 'dropTable':
        return [this.toCommand(schema.dropTable(op.table).compile(), irHash(op))];
      case 'addColumn':
        return [
          this.toCommand(
            schema
              .alterTable(op.table)
              .addColumn(op.column.name, dataType(op.column, false), (c: any) =>
                columnMods(c, op.column, false),
              )
              .compile(),
            irHash(op),
          ),
        ];
      case 'dropColumn':
        return [
          this.toCommand(schema.alterTable(op.table).dropColumn(op.column).compile(), irHash(op)),
        ];
      case 'createIndex': {
        let builder = schema.createIndex(op.name).on(op.table).columns([...op.columns]);
        if (op.unique) builder = builder.unique();
        return [this.toCommand(builder.compile(), irHash(op))];
      }
      case 'dropIndex':
        return [this.toCommand(schema.dropIndex(op.name).compile(), irHash(op))];
    }
  }

  compileRaw(
    strings: readonly string[],
    params: readonly unknown[],
    _ctx: GenContext,
  ): CompiledCommand {
    // Rebuild a TemplateStringsArray-like and let Kysely's `sql` tag produce
    // dialect-correct placeholders ($1 / ? …) and a parameter list.
    const raw = sql(strings as unknown as TemplateStringsArray, ...params);
    const compiled = raw.compile(this.db);
    return this.toCommand(compiled, irHash({ raw: [...strings], params: [...params] }));
  }

  compileWrite(op: WriteOp, ctx: GenContext): CompiledCommand {
    const table = this.table(op.entity, ctx);
    switch (op.kind) {
      case 'insert': {
        let q: any = this.db.insertInto(table).values(op.values);
        // MySQL/MSSQL have no INSERT … RETURNING; their executors read the
        // generated key from the driver result instead.
        if (this.supportsReturning) q = q.returningAll();
        return this.toCommand(q.compile(), irHash(op));
      }
      case 'update': {
        const q: any = this.db
          .updateTable(table)
          .set(op.values)
          .where((eb: AnyEb) => lower(op.predicate, eb));
        return this.toCommand(q.compile(), irHash(op));
      }
      case 'delete': {
        const q: any = this.db
          .deleteFrom(table)
          .where((eb: AnyEb) => lower(op.predicate, eb));
        return this.toCommand(q.compile(), irHash(op));
      }
    }
  }
}
