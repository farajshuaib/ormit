/**
 * `@ormit/cli` — the command facade behind the `ormit` binary (plan §8).
 *
 * The commands are exposed as an injectable facade (engine, model, committed
 * snapshot, registered migrations) so they are unit-testable without a real
 * filesystem or process; a thin `bin` wrapper wires the real dependencies.
 */
import {
  deserializeSnapshot,
  isDestructive,
  type MigrationOperation,
  type ModelSnapshot,
  type OrmEngine,
} from '@ormit/core';
import {
  diffWithDown,
  emitMigration,
  EMPTY_SNAPSHOT,
  Migrator,
  repairSnapshot,
  type EmittedMigration,
  type Migration,
  type RepairResult,
} from '@ormit/migrations';

export interface CliContext {
  readonly engine: OrmEngine;
  readonly model: ModelSnapshot;
  /** The committed `.snapshot.json`, or undefined for the first migration. */
  readonly committedSnapshot?: string;
  /** Migrations already emitted (id-ordered). */
  readonly migrations: readonly Migration[];
}

export interface AddResult {
  readonly migration: EmittedMigration;
  /** The new snapshot to commit alongside the migration. */
  readonly snapshot: string;
  readonly destructive: boolean;
}

export interface Cli {
  /** `ormit migrations add <name>` — diff the model against the committed
   * snapshot and emit a migration (+ the snapshot to commit). */
  add(name: string): AddResult;
  /** `ormit migrations list` — applied vs. pending ids. */
  list(): Promise<{ applied: string[]; pending: string[] }>;
  /** `ormit database update` — apply pending migrations (idempotent). */
  update(): Promise<string[]>;
  /** `ormit database update --down N` — revert the last N. */
  revert(count?: number): Promise<string[]>;
  /** `ormit migrations repair` — re-derive the canonical snapshot. */
  repair(): RepairResult;
  /** `ormit script` — the raw forward DDL for the given migrations. */
  script(): string;
}

export function createCli(ctx: CliContext): Cli {
  const from = ctx.committedSnapshot
    ? deserializeSnapshot(ctx.committedSnapshot)
    : EMPTY_SNAPSHOT;

  const migrator = (): Migrator => new Migrator(ctx.engine, ctx.migrations);

  return {
    add(name) {
      const { up, down } = diffWithDown(from, ctx.model.data);
      if (up.length === 0) throw new Error('No model changes to migrate.');
      return {
        migration: emitMigration(name, up, down),
        snapshot: ctx.model.toJSON(),
        destructive: up.some(isDestructive),
      };
    },
    async list() {
      const applied = await migrator().applied();
      const appliedSet = new Set(applied);
      const pending = ctx.migrations.map((m) => m.id).filter((id) => !appliedSet.has(id));
      return { applied, pending };
    },
    update() {
      return migrator().up();
    },
    revert(count = 1) {
      return migrator().down(count);
    },
    repair() {
      return repairSnapshot(ctx.model, ctx.committedSnapshot);
    },
    script() {
      const compile = ctx.engine.generator.compileDdl;
      if (!compile) throw new Error('This engine does not support DDL.');
      const lines: string[] = ['-- Ormit forward migration script'];
      for (const migration of ctx.migrations) {
        lines.push(`-- ${migration.id}`);
        for (const op of migration.up as MigrationOperation[]) {
          for (const cmd of compile.call(ctx.engine.generator, op, { tables: new Map() })) {
            lines.push(`${cmd.sql};`);
          }
        }
      }
      return lines.join('\n') + '\n';
    },
  };
}
