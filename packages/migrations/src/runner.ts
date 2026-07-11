/**
 * Migration runner (plan §8): applies pending migrations forward and reverts
 * them, tracking state in an `__ormit_migrations` history table. `up()` is
 * idempotent — already-applied migrations are skipped, so it can run twice
 * cleanly. Each migration runs in its own transaction where the dialect allows.
 */
import type {
  CompiledCommand,
  GenContext,
  MigrationOperation,
  OrmEngine,
} from '@ormit/core';

export interface Migration {
  readonly id: string;
  readonly up: readonly MigrationOperation[];
  readonly down: readonly MigrationOperation[];
}

const HISTORY = '__ormit_migrations';

const HISTORY_TABLE: MigrationOperation = {
  kind: 'createTable',
  table: HISTORY,
  schema: null,
  primaryKey: ['id'],
  columns: [
    { name: 'id', type: 'string', nullable: false, maxLength: null, defaultValue: null, defaultValueSql: null },
    { name: 'appliedAt', type: 'string', nullable: false, maxLength: null, defaultValue: null, defaultValueSql: null },
  ],
};

export class Migrator {
  private readonly genCtx: GenContext = { tables: new Map() };

  constructor(
    private readonly engine: OrmEngine,
    private readonly migrations: readonly Migration[],
  ) {}

  private ddl(op: MigrationOperation): CompiledCommand[] {
    const compile = this.engine.generator.compileDdl;
    if (!compile) throw new Error('This engine does not support migrations (no compileDdl).');
    return compile.call(this.engine.generator, op, this.genCtx);
  }

  private async raw(strings: string[], params: unknown[]): Promise<readonly CompiledCommand[]> {
    return [this.engine.generator.compileRaw(strings, params, this.genCtx)];
  }

  async ensureHistory(): Promise<void> {
    for (const cmd of this.ddl(HISTORY_TABLE)) {
      try {
        await this.engine.executor.execute(cmd);
      } catch {
        /* table already exists */
      }
    }
  }

  async applied(): Promise<string[]> {
    await this.ensureHistory();
    const cmd = this.engine.generator.compileRaw(
      [`SELECT "id" FROM "${HISTORY}" ORDER BY "id"`],
      [],
      this.genCtx,
    );
    const rows = await this.engine.executor.query(cmd);
    return rows.map((r) => String(r['id']));
  }

  /** Apply all pending migrations in id order. Returns the ids applied. */
  async up(): Promise<string[]> {
    const done = new Set(await this.applied());
    const pending = [...this.migrations]
      .filter((m) => !done.has(m.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const applied: string[] = [];
    for (const migration of pending) {
      await this.transaction(async () => {
        for (const op of migration.up) {
          for (const cmd of this.ddl(op)) await this.engine.executor.execute(cmd);
        }
        await this.record(migration.id);
      });
      applied.push(migration.id);
    }
    return applied;
  }

  /** Revert the last `count` applied migrations. Returns the ids reverted. */
  async down(count = 1): Promise<string[]> {
    const history = await this.applied();
    const targets = history.slice(-count).reverse();
    const reverted: string[] = [];
    for (const id of targets) {
      const migration = this.migrations.find((m) => m.id === id);
      if (!migration) throw new Error(`Migration '${id}' is in history but not registered.`);
      await this.transaction(async () => {
        for (const op of migration.down) {
          for (const cmd of this.ddl(op)) await this.engine.executor.execute(cmd);
        }
        await this.unrecord(id);
      });
      reverted.push(id);
    }
    return reverted;
  }

  private async record(id: string): Promise<void> {
    const [cmd] = await this.raw(
      [`INSERT INTO "${HISTORY}" ("id","appliedAt") VALUES (`, `, `, `)`],
      [id, new Date().toISOString()],
    );
    await this.engine.executor.execute(cmd!);
  }

  private async unrecord(id: string): Promise<void> {
    const [cmd] = await this.raw([`DELETE FROM "${HISTORY}" WHERE "id" = `, ``], [id]);
    await this.engine.executor.execute(cmd!);
  }

  private async transaction(work: () => Promise<void>): Promise<void> {
    const executor = this.engine.executor;
    if (executor.transaction) await executor.transaction(work); // method call keeps `this`
    else await work();
  }
}
