import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder, type OrmPlugin } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';
import { multitenancy, softDelete, timestamps } from '@ormit/plugins';

class Note {
  id!: number;
  text!: string;
  isDeleted!: boolean;
  createdAt!: string;
  updatedAt!: string;
  tenantId!: string;
}

function makeDb(plugins: OrmPlugin[]): { engine: SqliteEngine; make: () => TestDb } {
  const engine = new SqliteEngine(':memory:');
  engine.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT, updatedAt TEXT,
      tenantId TEXT
    );
  `);
  class TestDb extends DbContext {
    notes = this.set(Note);
    constructor(opts: DbContextOptions) {
      super(opts);
    }
    protected onModelCreating(model: ModelBuilder): void {
      model.entity(Note, (e) => e.toTable('notes').hasKey('id'));
    }
  }
  return { engine, make: () => new TestDb({ engine, plugins }) };
}
type TestDb = DbContext & { notes: import('@ormit/core').DbSet<Note> };

describe('soft-delete plugin (dogfood: public plugin surface only)', () => {
  let engine: SqliteEngine;
  let make: () => TestDb;
  beforeEach(() => ({ engine, make } = makeDb([softDelete()])));

  it('rewrites remove() into an update of the flag and hides the row', async () => {
    const db = make();
    const note = db.notes.add(Object.assign(new Note(), { text: 'hi' }));
    await db.saveChanges();

    db.notes.remove(note);
    await db.saveChanges();

    // Physically present, but filtered out of normal reads.
    expect(await make().notes.count()).toBe(0);
    expect(await make().notes.ignoreQueryFilters().count()).toBe(1);
    const raw = engine.db.prepare('SELECT isDeleted FROM notes WHERE id = ?').get(note.id) as {
      isDeleted: number;
    };
    expect(raw.isDeleted).toBe(1);
  });
});

describe('timestamps plugin', () => {
  it('stamps createdAt/updatedAt on insert and updatedAt on modify', async () => {
    const clock = { t: new Date('2026-01-01T00:00:00Z') };
    const { make } = makeDb([timestamps({ now: () => clock.t })]);
    const db = make();
    const note = db.notes.add(Object.assign(new Note(), { text: 'a' }));
    await db.saveChanges();
    expect(note.createdAt).toBe('2026-01-01T00:00:00.000Z');

    clock.t = new Date('2026-02-02T00:00:00Z');
    note.text = 'b';
    await db.saveChanges();
    // Re-read to observe the persisted value (updates have no RETURNING).
    const reread = await make().notes.first();
    expect(reread.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(reread.createdAt).toBe('2026-01-01T00:00:00.000Z'); // unchanged
  });
});

describe('multitenancy plugin', () => {
  it('scopes reads and stamps inserts by the ambient tenant', async () => {
    const als = new AsyncLocalStorage<string>();
    const tenant = () => als.getStore() ?? 'unknown';
    const { make } = makeDb([multitenancy({ tenant })]);

    await als.run('acme', async () => {
      const db = make();
      db.notes.add(Object.assign(new Note(), { text: 'acme-note' }));
      await db.saveChanges();
    });
    await als.run('globex', async () => {
      const db = make();
      db.notes.add(Object.assign(new Note(), { text: 'globex-note' }));
      await db.saveChanges();
    });

    // Each tenant sees only its own rows.
    const acme = await als.run('acme', async () => make().notes.toList());
    expect(acme.map((n) => n.text)).toEqual(['acme-note']);
    const globex = await als.run('globex', async () => make().notes.toList());
    expect(globex.map((n) => n.text)).toEqual(['globex-note']);
  });
});

describe('plugin composition', () => {
  it('soft-delete + timestamps + multitenancy coexist', async () => {
    const clock = () => new Date('2026-03-03T00:00:00Z');
    const { make } = makeDb([
      softDelete(),
      timestamps({ now: clock }),
      multitenancy({ tenant: () => 'acme' }),
    ]);
    const db = make();
    const note = db.notes.add(Object.assign(new Note(), { text: 'x' }));
    await db.saveChanges();
    expect(note.tenantId).toBe('acme');
    expect(note.createdAt).toBe('2026-03-03T00:00:00.000Z');

    db.notes.remove(note);
    await db.saveChanges();
    expect(await make().notes.count()).toBe(0); // soft-deleted + tenant-scoped
  });
});
