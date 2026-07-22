import { describe, expect, it } from 'vitest';
import { ModelBuilder, ModelSnapshot } from '@ormit/core';
import { diffWithDown, EMPTY_SNAPSHOT, snapshotData, type Migration } from '@ormit/migrations';
import { SqliteEngine } from '@ormit/sqlite';
import { createCli } from '@ormit/cli';

class Widget {
  id!: number;
  label!: string;
}

function model(): ModelSnapshot {
  const m = new ModelBuilder();
  m.entity(Widget, (e) => {
    e.toTable('widgets').hasKey('id');
    e.property((x) => x.label).hasMaxLength(50);
  });
  return ModelSnapshot.build(m);
}

describe('CLI facade', () => {
  it('add() emits a migration and the snapshot to commit', () => {
    const cli = createCli({ engine: new SqliteEngine(), model: model(), migrations: [] });
    const result = cli.add('init widgets');
    expect(result.migration.id).toMatch(/_init_widgets$/);
    expect(result.migration.source).toContain('createTable');
    expect(result.snapshot).toBe(model().toJSON());
    expect(result.destructive).toBe(false);
  });

  it('add() refuses when there are no model changes', () => {
    const committed = model().toJSON();
    const cli = createCli({
      engine: new SqliteEngine(),
      model: model(),
      committedSnapshot: committed,
      migrations: [],
    });
    expect(() => cli.add('noop')).toThrow(/no model changes/i);
  });

  it('update() applies pending, list() reports applied vs pending', async () => {
    const engine = new SqliteEngine(':memory:');
    const { up, down } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(model()));
    const migrations: Migration[] = [{ id: '0001_init', up, down }];
    const cli = createCli({ engine, model: model(), migrations });

    expect((await cli.list()).pending).toEqual(['0001_init']);
    expect(await cli.update()).toEqual(['0001_init']);
    const listed = await cli.list();
    expect(listed.applied).toEqual(['0001_init']);
    expect(listed.pending).toEqual([]);
    engine.close();
  });

  it('script() renders forward DDL', () => {
    const { up, down } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(model()));
    const cli = createCli({
      engine: new SqliteEngine(),
      model: model(),
      migrations: [{ id: '0001_init', up, down }],
    });
    const sql = cli.script();
    expect(sql).toContain('create table "widgets"');
    expect(sql).toContain('0001_init');
  });

  it('remove() refuses when there are no migrations', async () => {
    const cli = createCli({ engine: new SqliteEngine(), model: model(), migrations: [] });
    await expect(cli.remove()).rejects.toThrow(/no migrations to remove/i);
  });

  it('remove() refuses when the most recent migration is already applied', async () => {
    const engine = new SqliteEngine(':memory:');
    const { up, down } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(model()));
    const migrations: Migration[] = [{ id: '0001_init', up, down }];
    const cli = createCli({ engine, model: model(), migrations });
    await cli.update();
    await expect(cli.remove()).rejects.toThrow(/already been applied/i);
    engine.close();
  });

  it('remove() succeeds for an unapplied migration and returns the current snapshot', async () => {
    const engine = new SqliteEngine(':memory:');
    const { up, down } = diffWithDown(EMPTY_SNAPSHOT, snapshotData(model()));
    const migrations: Migration[] = [{ id: '0001_init', up, down }];
    const cli = createCli({ engine, model: model(), migrations });
    const result = await cli.remove();
    expect(result.id).toBe('0001_init');
    expect(result.snapshot).toBe(model().toJSON());
    engine.close();
  });

  it('hasPendingChanges() reflects the diff against the committed snapshot', () => {
    const upToDate = createCli({
      engine: new SqliteEngine(),
      model: model(),
      committedSnapshot: model().toJSON(),
      migrations: [],
    });
    expect(upToDate.hasPendingChanges()).toBe(false);

    const noCommittedSnapshot = createCli({ engine: new SqliteEngine(), model: model(), migrations: [] });
    expect(noCommittedSnapshot.hasPendingChanges()).toBe(true);
  });
});
