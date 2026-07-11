/**
 * `@ormit/mysql` — the MySQL dialect (plan §2).
 *
 * Kysely `mysql` generator + a mysql2 executor. MySQL has no INSERT … RETURNING,
 * so the executor synthesizes the generated key from the driver's `insertId`
 * (returningStrategy 'lastInsertId'). MySQL implicitly commits DDL, so
 * `ddlInTransaction` is false — migrations are not atomic there (plan §6).
 */
import { createPool, type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
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

export const MYSQL_CAPABILITIES: DialectCapabilities = {
  returningStrategy: 'lastInsertId',
  ddlInTransaction: false,
  savepoints: true,
  maxParams: 65535,
  upsertSyntax: 'onDuplicateKey',
  ilike: false,
  paging: 'limitOffset',
};

function bind(params: readonly unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

class MysqlExecutor implements IQueryExecutor {
  readonly capabilities = MYSQL_CAPABILITIES;
  private txConn: PoolConnection | undefined;

  constructor(private readonly pool: Pool) {}

  private get runner(): Pick<Pool, 'query'> {
    return this.txConn ?? this.pool;
  }

  async query(cmd: CompiledCommand): Promise<readonly Row[]> {
    const [rows] = await this.runner.query(cmd.sql, bind(cmd.params));
    return rows as Row[];
  }

  async execute(cmd: CompiledCommand): Promise<ExecuteResult> {
    const [result] = await this.runner.query(cmd.sql, bind(cmd.params));
    const header = result as ResultSetHeader;
    const returning = header.insertId ? [{ id: header.insertId } as Row] : undefined;
    return { affected: header.affectedRows ?? 0, ...(returning ? { returning } : {}) };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.txConn) return work();
    const conn = await this.pool.getConnection();
    this.txConn = conn;
    try {
      await conn.beginTransaction();
      const result = await work();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      this.txConn = undefined;
      conn.release();
    }
  }
}

export class MysqlEngine implements OrmEngine {
  readonly generator: ISqlGenerator = new KyselySqlGenerator('mysql');
  readonly executor: IQueryExecutor;
  private readonly pool: Pool;

  constructor(config: Parameters<typeof createPool>[0]) {
    this.pool = createPool(config);
    this.executor = new MysqlExecutor(this.pool);
  }

  /** Run raw SQL/DDL (schema setup, migrations). */
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
