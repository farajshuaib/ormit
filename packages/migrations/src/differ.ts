/**
 * Model differ (plan §6/§8, ADR-006): compares two committed `ModelSnapshot`s
 * — never the live database — and emits the `MigrationOperation[]` that turns
 * `from` into `to`. The reverse diff yields the auto-down.
 *
 * Owned types share their owner's table, so operations are computed per
 * *physical table* (columns from all entities mapped to it are merged).
 */
import type {
  ColumnDef,
  EntitySnapshot,
  MigrationOperation,
  ModelSnapshot,
  ModelSnapshotData,
  PropertySnapshot,
} from '@ormit/core';

interface TableModel {
  readonly table: string;
  readonly schema: string | null;
  readonly columns: Map<string, ColumnDef>;
  primaryKey: string[];
  readonly indexes: Map<string, { columns: string[]; unique: boolean }>;
}

export function diffSnapshots(
  from: ModelSnapshotData,
  to: ModelSnapshotData,
): MigrationOperation[] {
  const before = tableModels(from);
  const after = tableModels(to);
  const ops: MigrationOperation[] = [];

  // Dropped tables (and their indexes go with them).
  for (const [table, model] of before) {
    if (!after.has(table)) ops.push({ kind: 'dropTable', table, schema: model.schema });
  }

  for (const [table, next] of after) {
    const prev = before.get(table);
    if (!prev) {
      ops.push({
        kind: 'createTable',
        table,
        schema: next.schema,
        columns: [...next.columns.values()],
        primaryKey: next.primaryKey,
      });
      for (const [name, idx] of next.indexes) {
        ops.push({ kind: 'createIndex', table, name, columns: idx.columns, unique: idx.unique });
      }
      continue;
    }
    // Column add/drop.
    for (const [name, col] of next.columns) {
      if (!prev.columns.has(name)) ops.push({ kind: 'addColumn', table, column: col });
    }
    for (const name of prev.columns.keys()) {
      if (!next.columns.has(name)) ops.push({ kind: 'dropColumn', table, column: name });
    }
    // Index add/drop.
    for (const [name, idx] of next.indexes) {
      if (!prev.indexes.has(name)) {
        ops.push({ kind: 'createIndex', table, name, columns: idx.columns, unique: idx.unique });
      }
    }
    for (const name of prev.indexes.keys()) {
      if (!next.indexes.has(name)) ops.push({ kind: 'dropIndex', table, name });
    }
  }

  return ops;
}

/** Convenience: the up/down pair between two snapshots. */
export function diffWithDown(
  from: ModelSnapshotData,
  to: ModelSnapshotData,
): { up: MigrationOperation[]; down: MigrationOperation[] } {
  return { up: diffSnapshots(from, to), down: diffSnapshots(to, from) };
}

/** The current model as a snapshot, for diffing against a committed one. */
export function snapshotData(model: ModelSnapshot): ModelSnapshotData {
  return model.data;
}

/** An empty baseline (the "before" of the very first migration). */
export const EMPTY_SNAPSHOT: ModelSnapshotData = { version: 1, entities: [] };

// ---------------------------------------------------------------------------

function tableModels(snapshot: ModelSnapshotData): Map<string, TableModel> {
  const map = new Map<string, TableModel>();
  for (const entity of snapshot.entities) {
    let model = map.get(entity.table);
    if (!model) {
      model = {
        table: entity.table,
        schema: entity.schema,
        columns: new Map(),
        primaryKey: [],
        indexes: new Map(),
      };
      map.set(entity.table, model);
    }
    for (const p of entity.properties) model.columns.set(p.column, toColumnDef(p));
    // The non-owned entity carries the table's primary key.
    if (entity.key.length > 0) model.primaryKey = entity.key.map((k) => columnOf(entity, k));
    for (const idx of entity.indexes) {
      model.indexes.set(idx.name, {
        columns: idx.properties.map((prop) => columnOf(entity, prop)),
        unique: idx.unique,
      });
    }
  }
  return map;
}

function toColumnDef(p: PropertySnapshot): ColumnDef {
  return {
    name: p.column,
    type: p.type,
    nullable: p.nullable,
    maxLength: p.maxLength,
    defaultValue: p.defaultValue,
    defaultValueSql: p.defaultValueSql,
  };
}

function columnOf(entity: EntitySnapshot, propertyName: string): string {
  return entity.properties.find((p) => p.name === propertyName)?.column ?? propertyName;
}
