// Benchmark harness with a ±10% regression gate (plan §9).
//
// Absolute rows/sec vary by machine, so the gate is on Ormit's throughput
// *ratio versus the raw better-sqlite3 driver* on the same DB handle — a
// stable, machine-independent measure of ORM overhead. The committed baseline
// records those ratios; the gate fails if a ratio drops more than 10% (i.e.
// Ormit got meaningfully slower relative to the raw driver).
//
//   node scripts/bench.mjs              # print a report
//   BENCH_GATE=1 node scripts/bench.mjs # + enforce the ±10% regression gate
//   UPDATE_BASELINE=1 node scripts/bench.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbContext } from '../packages/core/dist/index.js';
import { SqliteEngine } from '../packages/dialect-sqlite/dist/index.js';

const BASELINE = fileURLToPath(new URL('../bench/baseline.json', import.meta.url));
const N = 2000;
const ITERS = 5;
const TOLERANCE = 0.9; // ratio must stay >= 90% of baseline

class Row {
  id;
  name;
  age;
}
class BenchDb extends DbContext {
  rows = this.set(Row);
  onModelCreating(m) {
    m.entity(Row, (e) => e.toTable('rows').hasKey('id'));
  }
}

function fresh() {
  const engine = new SqliteEngine(':memory:');
  engine.exec(`CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER);`);
  return engine;
}

/** Best (fastest) rows/sec over ITERS runs of `fn` inserting/reading N rows. */
async function best(setup, fn) {
  let bestRps = 0;
  for (let i = 0; i < ITERS; i++) {
    const ctx = setup();
    const start = performance.now();
    await fn(ctx);
    const ms = performance.now() - start;
    bestRps = Math.max(bestRps, (N / ms) * 1000);
    ctx.close?.();
  }
  return Math.round(bestRps);
}

async function ormitInsert(engine) {
  const db = new BenchDb({ engine });
  for (let i = 0; i < N; i++) db.rows.add(Object.assign(new Row(), { name: `n${i}`, age: i % 100 }));
  await db.saveChanges();
}
function rawInsert(engine) {
  const stmt = engine.db.prepare('INSERT INTO rows (name, age) VALUES (?, ?)');
  engine.db.transaction(() => {
    for (let i = 0; i < N; i++) stmt.run(`n${i}`, i % 100);
  })();
}

const metrics = {};

// Insert throughput.
metrics.ormitInsert = await best(fresh, ormitInsert);
metrics.rawInsert = await best(fresh, (e) => rawInsert(e));
metrics.insertRatio = round(metrics.ormitInsert / metrics.rawInsert);

// Read throughput (seed once, then time the scan + materialization).
const seeded = () => {
  const e = fresh();
  rawInsert(e);
  return e;
};
metrics.ormitRead = await best(seeded, (e) => new BenchDb({ engine: e }).rows.toList());
metrics.rawRead = await best(seeded, (e) => {
  e.db.prepare('SELECT * FROM rows').all();
});
metrics.readRatio = round(metrics.ormitRead / metrics.rawRead);

// ---- report ----
const fmt = (n) => n.toLocaleString();
console.log(`\nOrmit benchmark (SQLite, N=${N}, best of ${ITERS})`);
console.log(`  insert:  ormit ${fmt(metrics.ormitInsert)}/s  vs raw ${fmt(metrics.rawInsert)}/s  → ${metrics.insertRatio}x`);
console.log(`  read:    ormit ${fmt(metrics.ormitRead)}/s  vs raw ${fmt(metrics.rawRead)}/s  → ${metrics.readRatio}x`);

// ---- baseline + gate ----
if (process.env.UPDATE_BASELINE || !existsSync(BASELINE)) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ insertRatio: metrics.insertRatio, readRatio: metrics.readRatio }, null, 2) + '\n');
  console.log(`\nbaseline written to ${BASELINE}`);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const checks = [
  ['insertRatio', metrics.insertRatio, baseline.insertRatio],
  ['readRatio', metrics.readRatio, baseline.readRatio],
];
let regressed = false;
for (const [name, current, base] of checks) {
  const floor = round(base * TOLERANCE);
  const ok = current >= floor;
  console.log(`  gate ${name}: ${current} (baseline ${base}, floor ${floor}) ${ok ? 'OK' : 'REGRESSION'}`);
  if (!ok) regressed = true;
}

if (regressed && process.env.BENCH_GATE) {
  console.error('\nFAIL: throughput regressed more than 10% vs baseline');
  process.exit(1);
}

function round(n) {
  return Math.round(n * 100) / 100;
}
