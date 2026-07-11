/**
 * Engine seam (plan §4, FROZEN within workspace).
 * `core` knows only these interfaces — never Kysely, never a driver.
 */
import type { SelectExpr, WriteOp } from '../ir/nodes.js';
import type { MigrationOperation } from '../migrations/operations.js';

export interface CompiledCommand {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly irHash: string;
}

export interface GenContext {
  /** entity name -> table name (minimal metadata slice for M1). */
  readonly tables: ReadonlyMap<string, string>;
}

export interface ISqlGenerator {
  compileSelect(query: SelectExpr, ctx: GenContext): CompiledCommand;
  compileWrite(op: WriteOp, ctx: GenContext): CompiledCommand;
  /** Compile a raw tagged-template query into dialect-correct SQL + params. */
  compileRaw(
    strings: readonly string[],
    params: readonly unknown[],
    ctx: GenContext,
  ): CompiledCommand;
  /** Compile a migration operation to DDL. Optional (not all engines do DDL). */
  compileDdl?(op: MigrationOperation, ctx: GenContext): CompiledCommand[];
}

export type Row = Record<string, unknown>;

export interface ExecuteResult {
  readonly affected: number;
  readonly returning?: readonly Row[];
}

/** Per-dialect quirks the pipeline adapts to (plan §4). */
export interface DialectCapabilities {
  readonly returningStrategy: 'returning' | 'output' | 'lastInsertId' | 'secondQuery';
  readonly ddlInTransaction: boolean;
  readonly savepoints: boolean;
  readonly maxParams: number;
  readonly upsertSyntax: 'onConflict' | 'onDuplicateKey' | 'merge';
  readonly ilike: boolean;
  readonly paging: 'limitOffset' | 'offsetFetch';
}

export interface IQueryExecutor {
  query(cmd: CompiledCommand): Promise<readonly Row[]>;
  execute(cmd: CompiledCommand): Promise<ExecuteResult>;
  readonly capabilities: DialectCapabilities;
  /** Run `work` atomically. Optional; a missing impl means no rollback. */
  transaction?<T>(work: () => Promise<T>): Promise<T>;
}

export interface OrmEngine {
  readonly generator: ISqlGenerator;
  readonly executor: IQueryExecutor;
}
