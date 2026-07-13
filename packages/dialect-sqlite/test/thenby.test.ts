import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { SqliteEngine } from '@ormit/sqlite';

class Person {
  id!: number;
  team!: string;
  age!: number;
  name!: string;
}

class AppDb extends DbContext {
  people = this.set(Person);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(Person, (e) => e.toTable('people').hasKey('id'));
  }
}

let engine: SqliteEngine;
let db: AppDb;

beforeEach(async () => {
  engine = new SqliteEngine(':memory:');
  engine.exec(`
    CREATE TABLE people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      age INTEGER NOT NULL,
      name TEXT NOT NULL
    );
  `);
  db = new AppDb({ engine });
  db.people.addRange([
    Object.assign(new Person(), { team: 'B', age: 30, name: 'Amal' }),
    Object.assign(new Person(), { team: 'A', age: 30, name: 'Bilal' }),
    Object.assign(new Person(), { team: 'A', age: 25, name: 'Aisha' }),
    Object.assign(new Person(), { team: 'A', age: 30, name: 'Aziz' }),
  ]);
  await db.saveChanges();
});

afterEach(() => engine.close());

describe('@ormit/sqlite · thenBy secondary ordering', () => {
  it('orderBy then thenBy sorts by successive keys', async () => {
    const rows = await db.people
      .orderBy((x) => x.team)
      .thenBy((x) => x.age)
      .thenBy((x) => x.name)
      .toList();
    expect(rows.map((p) => `${p.team}/${p.age}/${p.name}`)).toEqual([
      'A/25/Aisha',
      'A/30/Aziz',
      'A/30/Bilal',
      'B/30/Amal',
    ]);
  });

  it('thenByDescending flips only the secondary key', async () => {
    const rows = await db.people
      .orderBy((x) => x.team)
      .thenByDescending((x) => x.age)
      .thenBy((x) => x.name)
      .toList();
    expect(rows.map((p) => `${p.team}/${p.age}`)).toEqual([
      'A/30',
      'A/30',
      'A/25',
      'B/30',
    ]);
  });

  it('orderByDescending is also chainable with thenBy', async () => {
    const rows = await db.people
      .orderByDescending((x) => x.team)
      .thenBy((x) => x.name)
      .toList();
    expect(rows.map((p) => p.team)[0]).toBe('B');
  });
});
