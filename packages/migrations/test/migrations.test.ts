import { describe, expect, it } from 'vitest';
import {
  DbContext,
  ModelBuilder,
  ModelSnapshot,
  type DbContextOptions,
  type ModelBuilder as MB,
} from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';
import {
  diffSnapshots,
  diffWithDown,
  EMPTY_SNAPSHOT,
  emitMigration,
  migrationId,
  Migrator,
  repairSnapshot,
  snapshotData,
  type Migration,
} from '@ormit/migrations';

class User {
  id!: number;
  name!: string;
  age!: number;
}

function modelV1(): ModelSnapshot {
  const m = new ModelBuilder();
  m.entity(User, (e) => {
    e.toTable('users').hasKey('id');
    e.property((x) => x.name).hasMaxLength(100);
  });
  return ModelSnapshot.build(m);
}
function modelV2(): ModelSnapshot {
  const m = new ModelBuilder();
  m.entity(User, (e) => {
    e.toTable('users').hasKey('id');
    e.property((x) => x.name).hasMaxLength(100);
    e.property((x) => x.age).hasType('number').isRequired(false);
  });
  return ModelSnapshot.build(m);
}

// A context whose model matches V2 (used to exercise the migrated schema).
class AppDb extends DbContext {
  users = this.set(User);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: MB): void {
    model.entity(User, (e) => {
      e.toTable('users').hasKey('id');
      e.property((x) => x.name).hasMaxLength(100);
      e.property((x) => x.age).hasType('number').isRequired(false);
    });
  }
}

describe('model differ', () => {
  it('creates tables from the empty baseline', () => {
    const ops = diffSnapshots(EMPTY_SNAPSHOT, snapshotData(modelV1()));
    expect(ops).toHaveLength(1);
    const [create] = ops;
    expect(create).toMatchObject({ kind: 'createTable', table: 'users' });
    const columns = (create as { columns: { name: string }[] }).columns.map((c) => c.name).sort();
    expect(columns).toEqual(['id', 'name']);
  });

  it('detects an added column and its auto-down', () => {
    const { up, down } = diffWithDown(snapshotData(modelV1()), snapshotData(modelV2()));
    expect(up).toEqual([
      { kind: 'addColumn', table: 'users', column: expect.objectContaining({ name: 'age' }) },
    ]);
    expect(down).toEqual([{ kind: 'dropColumn', table: 'users', column: 'age' }]);
  });

  it('detects a dropped table', () => {
    const ops = diffSnapshots(snapshotData(modelV1()), EMPTY_SNAPSHOT);
    expect(ops).toEqual([{ kind: 'dropTable', table: 'users', schema: null }]);
  });
});

describe('emitter', () => {
  it('emits a TS migration with a timestamped id', () => {
    const at = new Date('2026-01-02T03:04:05Z');
    const { up } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(modelV1()));
    const emitted = emitMigration('Add users', up, [], at);
    expect(emitted.id).toBe(migrationId('Add users', at));
    expect(emitted.id).toMatch(/^20260102030405_add_users$/);
    expect(emitted.source).toContain('export const up: MigrationOperation[]');
    expect(emitted.filename).toBe(`${emitted.id}.ts`);
  });
});

function migrationsFor(): Migration[] {
  const v1 = diffWithDown(EMPTY_SNAPSHOT, snapshotData(modelV1()));
  const v2 = diffWithDown(snapshotData(modelV1()), snapshotData(modelV2()));
  return [
    { id: '0001_init', up: v1.up, down: v1.down },
    { id: '0002_add_age', up: v2.up, down: v2.down },
  ];
}

describe('runner · forward and back on SQLite', () => {
  it('migrates up to a working schema', async () => {
    const engine = new SqliteEngine(':memory:');
    const migrator = new Migrator(engine, migrationsFor());
    expect(await migrator.up()).toEqual(['0001_init', '0002_add_age']);

    // The migrated schema is usable.
    const db = new AppDb({ engine });
    db.users.add(Object.assign(new User(), { name: 'Amal', age: 30 }));
    expect(await db.saveChanges()).toBe(1);
    const user = await db.users.first();
    expect(user).toMatchObject({ name: 'Amal', age: 30 });
    engine.close();
  });

  it('up() is idempotent (applies twice cleanly)', async () => {
    const engine = new SqliteEngine(':memory:');
    const migrator = new Migrator(engine, migrationsFor());
    await migrator.up();
    expect(await migrator.up()).toEqual([]); // nothing pending the second time
    expect(await migrator.applied()).toEqual(['0001_init', '0002_add_age']);
    engine.close();
  });

  it('migrates down and back up (round-trip)', async () => {
    const engine = new SqliteEngine(':memory:');
    const migrator = new Migrator(engine, migrationsFor());
    await migrator.up();

    expect(await migrator.down(1)).toEqual(['0002_add_age']);
    // The `age` column is gone.
    const cols = engine.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain('age');

    // Re-apply forward.
    expect(await migrator.up()).toEqual(['0002_add_age']);
    const cols2 = engine.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    expect(cols2.map((c) => c.name)).toContain('age');
    engine.close();
  });
});

describe('repair · snapshot merge conflict', () => {
  it('re-derives the canonical snapshot and flags drift', () => {
    const model = modelV2();
    const clean = model.toJSON();

    // No drift when the committed text already matches.
    expect(repairSnapshot(model, clean).changed).toBe(false);

    // A git-conflicted snapshot is unparseable → repaired to canonical.
    const conflicted = `<<<<<<< HEAD\n{ "oops": true }\n=======\n{ "other": 1 }\n>>>>>>> branch\n`;
    const result = repairSnapshot(model, conflicted);
    expect(result.changed).toBe(true);
    expect(result.snapshot).toBe(clean);
  });
});
