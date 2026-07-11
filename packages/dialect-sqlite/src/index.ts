/**
 * `@ormit/sqlite` — the SQLite dialect (plan §2).
 *
 * Combines the Kysely SQL generator (`sqlite` compiler) with an executor backed
 * by better-sqlite3. Dialect packages never import `kysely` directly — only
 * `@ormit/engine-kysely`.
 */
import Database from 'better-sqlite3';
import { KyselySqlGenerator } from '@ormit/engine-kysely';
import type {
  CompiledCommand,
  DialectCapabilities,
  ExecuteResult,
  IQueryExecutor,
  ISqlGenerator,
  OrmEngine,
  Row,
} from '@ormit/core';

export const SQLITE_CAPABILITIES: DialectCapabilities = {
  returningStrategy: 'returning', // SQLite 3.35+ (better-sqlite3 bundles a modern build)
  ddlInTransaction: true,
  savepoints: true,
  maxParams: 32766,
  upsertSyntax: 'onConflict',
  ilike: false, // LIKE is case-insensitive for ASCII; no ILIKE keyword
  paging: 'limitOffset',
};

/** better-sqlite3 only binds numbers/strings/bigints/buffers/null. */
function toBindable(params: readonly unknown[]): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (p === undefined) return null;
    return p;
  });
}

const RETURNING = /\breturning\b/i;

class SqliteExecutor implements IQueryExecutor {
  readonly capabilities = SQLITE_CAPABILITIES;
  constructor(private readonly db: Database.Database) {}

  async query(cmd: CompiledCommand): Promise<readonly Row[]> {
    return this.db.prepare(cmd.sql).all(...toBindable(cmd.params)) as Row[];
  }

  async execute(cmd: CompiledCommand): Promise<ExecuteResult> {
    const stmt = this.db.prepare(cmd.sql);
    const params = toBindable(cmd.params);
    if (RETURNING.test(cmd.sql)) {
      const rows = stmt.all(...params) as Row[];
      return { affected: rows.length, returning: rows };
    }
    const info = stmt.run(...params);
    return { affected: info.changes };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export class SqliteEngine implements OrmEngine {
  readonly generator: ISqlGenerator;
  readonly executor: IQueryExecutor;
  /** The underlying better-sqlite3 handle (for DDL/migrations/tests). */
  readonly db: Database.Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.generator = new KyselySqlGenerator('sqlite');
    this.executor = new SqliteExecutor(this.db);
  }

  /** Run raw DDL/SQL (schema setup, migrations). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience factory. */
export function createSqliteEngine(filename = ':memory:'): SqliteEngine {
  return new SqliteEngine(filename);
}
