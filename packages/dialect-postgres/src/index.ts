/**
 * `@ormit/postgres` — the PostgreSQL dialect (plan §2).
 *
 * Kysely `postgres` generator + a node-postgres executor. Connection affinity
 * during a transaction is held on a single checked-out client; contexts are
 * short-lived and not concurrency-safe (plan §5), so a single in-flight
 * transaction per executor is sufficient.
 */
import pg from 'pg';
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

const { Pool } = pg;

export const POSTGRES_CAPABILITIES: DialectCapabilities = {
  returningStrategy: 'returning',
  ddlInTransaction: true,
  savepoints: true,
  maxParams: 65535,
  upsertSyntax: 'onConflict',
  ilike: true,
  paging: 'limitOffset',
};

function bind(params: readonly unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

class PostgresExecutor implements IQueryExecutor {
  readonly capabilities = POSTGRES_CAPABILITIES;
  private txClient: pg.PoolClient | undefined;

  constructor(private readonly pool: pg.Pool) {}

  private get runner(): Pick<pg.Pool, 'query'> {
    return this.txClient ?? this.pool;
  }

  async query(cmd: CompiledCommand): Promise<readonly Row[]> {
    const result = await this.runner.query(cmd.sql, bind(cmd.params));
    return result.rows as Row[];
  }

  async execute(cmd: CompiledCommand): Promise<ExecuteResult> {
    const result = await this.runner.query(cmd.sql, bind(cmd.params));
    const returning = result.rows.length > 0 ? (result.rows as Row[]) : undefined;
    return { affected: result.rowCount ?? 0, ...(returning ? { returning } : {}) };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.txClient) return work(); // join the ambient transaction
    const client = await this.pool.connect();
    this.txClient = client;
    try {
      await client.query('BEGIN');
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      this.txClient = undefined;
      client.release();
    }
  }
}

export class PostgresEngine implements OrmEngine {
  readonly generator: ISqlGenerator = new KyselySqlGenerator('postgres');
  readonly executor: IQueryExecutor;
  private readonly pool: pg.Pool;

  constructor(config: pg.PoolConfig | string) {
    this.pool = new Pool(typeof config === 'string' ? { connectionString: config } : config);
    this.executor = new PostgresExecutor(this.pool);
  }

  /** Run raw SQL/DDL (schema setup, migrations). */
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
