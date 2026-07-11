/**
 * `@ormit/mssql` — the SQL Server dialect (plan §2, §9 "MSSQL polish").
 *
 * Kysely `mssql` generator + a node-mssql executor. SQL Server has no
 * RETURNING; INSERTs use `OUTPUT INSERTED.*` (returningStrategy 'output') and
 * the executor reads the generated key from the returned recordset. Paging is
 * TOP / OFFSET…FETCH (handled in the generator). Transactions are
 * connection-affine via a node-mssql `Transaction`.
 */
import sql from 'mssql';
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

export const MSSQL_CAPABILITIES: DialectCapabilities = {
  returningStrategy: 'output',
  ddlInTransaction: true,
  savepoints: true,
  maxParams: 2100,
  upsertSyntax: 'merge',
  ilike: false,
  paging: 'offsetFetch',
};

function bindInto(request: sql.Request, params: readonly unknown[]): sql.Request {
  params.forEach((p, i) => request.input(String(i + 1), p === undefined ? null : p));
  return request;
}

class MssqlExecutor implements IQueryExecutor {
  readonly capabilities = MSSQL_CAPABILITIES;
  private tx: sql.Transaction | undefined;

  constructor(
    private readonly pool: sql.ConnectionPool,
    private readonly ready: () => Promise<unknown>,
  ) {}

  private async request(): Promise<sql.Request> {
    await this.ready();
    return this.tx ? new sql.Request(this.tx) : this.pool.request();
  }

  async query(cmd: CompiledCommand): Promise<readonly Row[]> {
    const request = bindInto(await this.request(), cmd.params);
    const result = await request.query(cmd.sql);
    return (result.recordset ?? []) as Row[];
  }

  async execute(cmd: CompiledCommand): Promise<ExecuteResult> {
    const request = bindInto(await this.request(), cmd.params);
    const result = await request.query(cmd.sql);
    const rows = result.recordset as Row[] | undefined;
    const returning = rows && rows.length > 0 ? rows : undefined;
    const affected = (result.rowsAffected ?? []).reduce((a, b) => a + b, 0);
    return { affected, ...(returning ? { returning } : {}) };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.tx) return work();
    await this.ready();
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    this.tx = tx;
    try {
      const result = await work();
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      this.tx = undefined;
    }
  }
}

export class MssqlEngine implements OrmEngine {
  readonly generator: ISqlGenerator = new KyselySqlGenerator('mssql');
  readonly executor: IQueryExecutor;
  private readonly pool: sql.ConnectionPool;
  private readonly connected: Promise<sql.ConnectionPool>;

  constructor(config: sql.config | string) {
    this.pool = new sql.ConnectionPool(config as sql.config);
    this.connected = this.pool.connect();
    this.executor = new MssqlExecutor(this.pool, () => this.connected);
  }

  /** Run raw SQL/DDL (schema setup, migrations). */
  async exec(ddl: string): Promise<void> {
    await this.connected;
    await this.pool.request().query(ddl);
  }

  async close(): Promise<void> {
    await this.connected.catch(() => undefined);
    await this.pool.close();
  }
}
