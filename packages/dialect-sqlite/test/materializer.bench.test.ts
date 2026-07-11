/**
 * Materializer benchmark baseline (Phase 4 gate).
 *
 * Measures end-to-end read throughput (SQL execution + materialization) over a
 * large result set and records a baseline. This is a recorded baseline, not a
 * hard perf gate — the nightly benchmark runner (plan §7) enforces the ±10%
 * regression band; here we only guarantee the number is captured and sane.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

const BASELINE = fileURLToPath(new URL('./fixtures/materializer-baseline.json', import.meta.url));
const ROWS = 20_000;

class Row {
  id!: number;
  name!: string;
  age!: number;
  active!: boolean;
}
class BenchDb extends DbContext {
  rows = this.set(Row);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(Row, (e) => e.toTable('rows').hasKey('id'));
  }
}

let engine: SqliteEngine;
let db: BenchDb;

beforeAll(() => {
  engine = new SqliteEngine(':memory:');
  engine.exec(`CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, active INTEGER);`);
  const insert = engine.db.prepare('INSERT INTO rows (id, name, age, active) VALUES (?, ?, ?, ?)');
  const tx = engine.db.transaction(() => {
    for (let i = 1; i <= ROWS; i++) insert.run(i, `name-${i}`, i % 100, i % 2);
  });
  tx();
  db = new BenchDb({ engine });
});

afterAll(() => engine.close());

describe('materializer benchmark', () => {
  it('materializes a large result set and records a baseline', async () => {
    // Warm up caches, then time a full scan + materialization.
    await db.rows.take(1).toList();
    const start = performance.now();
    const all = await db.rows.toList();
    const ms = performance.now() - start;

    expect(all).toHaveLength(ROWS);
    expect(all[0]).toBeInstanceOf(Row);

    const rowsPerSec = Math.round((ROWS / ms) * 1000);
    const record = { rows: ROWS, ms: Math.round(ms * 100) / 100, rowsPerSec };

    if (process.env['UPDATE_BASELINE'] || !existsSync(BASELINE)) {
      mkdirSync(dirname(BASELINE), { recursive: true });
      writeFileSync(BASELINE, JSON.stringify(record, null, 2) + '\n');
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { rowsPerSec: number };
    expect(baseline.rowsPerSec).toBeGreaterThan(0); // baseline is recorded
    // eslint-disable-next-line no-console
    console.log(`materializer: ${rowsPerSec.toLocaleString()} rows/sec (baseline ${baseline.rowsPerSec.toLocaleString()})`);
  });
});
