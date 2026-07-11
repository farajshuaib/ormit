/**
 * Migration operation set (plan §4/§6/§8). Produced by the model differ,
 * lowered to DDL by `ISqlGenerator.compileDdl`, and emitted into TS migration
 * files. Every operation is JSON-serializable.
 */
import type { ClrType, JsonValue } from '../metadata/types.js';

export interface ColumnDef {
  readonly name: string;
  readonly type: ClrType;
  readonly nullable: boolean;
  readonly maxLength: number | null;
  readonly defaultValue: JsonValue;
  readonly defaultValueSql: string | null;
}

export interface CreateTableOp {
  readonly kind: 'createTable';
  readonly table: string;
  readonly schema: string | null;
  readonly columns: readonly ColumnDef[];
  readonly primaryKey: readonly string[];
}
export interface DropTableOp {
  readonly kind: 'dropTable';
  readonly table: string;
  readonly schema: string | null;
}
export interface AddColumnOp {
  readonly kind: 'addColumn';
  readonly table: string;
  readonly column: ColumnDef;
}
export interface DropColumnOp {
  readonly kind: 'dropColumn';
  readonly table: string;
  readonly column: string;
}
export interface CreateIndexOp {
  readonly kind: 'createIndex';
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}
export interface DropIndexOp {
  readonly kind: 'dropIndex';
  readonly table: string;
  readonly name: string;
}

export type MigrationOperation =
  | CreateTableOp
  | DropTableOp
  | AddColumnOp
  | DropColumnOp
  | CreateIndexOp
  | DropIndexOp;

/** True for operations that can lose data (drives destructive-change prompts). */
export function isDestructive(op: MigrationOperation): boolean {
  return op.kind === 'dropTable' || op.kind === 'dropColumn';
}
