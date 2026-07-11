import { describe, expect, it } from 'vitest';
import {
  camelCase,
  capitalize,
  classifyValue,
  columnNameFor,
  defaultDeleteBehavior,
  discoverForeignKey,
  discoverKey,
  foreignKeyCandidates,
  inferClrType,
  isKeyByConvention,
  ownedColumnName,
  pluralize,
  tableNameFor,
} from '@ormit/core';

describe('conventions · pluralize (every branch)', () => {
  it('returns empty input unchanged', () => {
    expect(pluralize('')).toBe('');
  });

  it('leaves uncountable nouns alone', () => {
    expect(pluralize('sheep')).toBe('sheep');
    expect(pluralize('series')).toBe('series');
  });

  it('handles irregular plurals, preserving case', () => {
    expect(pluralize('person')).toBe('people'); // lowercase branch
    expect(pluralize('Person')).toBe('People'); // uppercase branch
    expect(pluralize('child')).toBe('children');
  });

  it('applies the -y rules', () => {
    expect(pluralize('baby')).toBe('babies'); // consonant + y
    expect(pluralize('day')).toBe('days'); // vowel + y
    expect(pluralize('y')).toBe('ys'); // no letter before y
  });

  it('adds -es to sibilant endings', () => {
    expect(pluralize('bus')).toBe('buses'); // s
    expect(pluralize('box')).toBe('boxes'); // x
    expect(pluralize('quiz')).toBe('quizes'); // z
    expect(pluralize('church')).toBe('churches'); // ch
    expect(pluralize('dish')).toBe('dishes'); // sh
  });

  it('turns -f / -fe into -ves', () => {
    expect(pluralize('knife')).toBe('knives'); // fe
    expect(pluralize('wolf')).toBe('wolves'); // f
  });

  it('falls back to a trailing -s', () => {
    expect(pluralize('cat')).toBe('cats');
    expect(pluralize('Blog')).toBe('Blogs');
  });
});

describe('conventions · naming', () => {
  it('derives table names by pluralizing the entity name', () => {
    expect(tableNameFor('User')).toBe('Users');
    expect(tableNameFor('Category')).toBe('Categories');
  });

  it('keeps column names identical to properties by default', () => {
    expect(columnNameFor('createdAt')).toBe('createdAt');
  });

  it('capitalizes words (both branches)', () => {
    expect(capitalize('')).toBe(''); // empty branch
    expect(capitalize('id')).toBe('Id'); // non-empty branch
  });

  it('camel-cases words (both branches)', () => {
    expect(camelCase('')).toBe(''); // empty branch
    expect(camelCase('User')).toBe('user'); // non-empty branch
  });

  it('flattens owned column names with a prefix', () => {
    expect(ownedColumnName('address', 'city')).toBe('address_city');
  });
});

describe('conventions · key discovery', () => {
  it('matches id / <Entity>Id case-insensitively', () => {
    expect(isKeyByConvention('id', 'User')).toBe(true); // 'id' branch
    expect(isKeyByConvention('ID', 'User')).toBe(true);
    expect(isKeyByConvention('userId', 'User')).toBe(true); // '<entity>id' branch
    expect(isKeyByConvention('name', 'User')).toBe(false); // neither
  });

  it('discovers a key or returns null', () => {
    expect(discoverKey('User', ['name', 'id'])).toBe('id'); // found
    expect(discoverKey('User', ['name', 'age'])).toBe(null); // not found
  });
});

describe('conventions · foreign-key discovery', () => {
  it('produces ordered FK candidates', () => {
    expect(foreignKeyCandidates('author', 'User', 'id')).toEqual([
      'authorId',
      'authorId',
      'userId',
      'userId',
    ]);
    expect(foreignKeyCandidates('owner', 'Account', 'code')).toEqual([
      'ownerCode',
      'ownerId',
      'accountCode',
      'accountId',
    ]);
  });

  it('finds the first present candidate, else null', () => {
    expect(discoverForeignKey('author', 'User', 'id', ['authorId', 'title'])).toBe('authorId');
    expect(discoverForeignKey('author', 'User', 'id', ['title'])).toBe(null);
  });
});

describe('conventions · type inference (every branch)', () => {
  it('prefers an explicit type', () => {
    expect(inferClrType({ explicit: 'Date' })).toBe('Date');
  });
  it('treats a max length as a string', () => {
    expect(inferClrType({ maxLength: 200 })).toBe('string');
  });
  it('classifies a literal default, else unknown', () => {
    expect(inferClrType({ defaultValue: 'x' })).toBe('string');
    expect(inferClrType({})).toBe('unknown');
  });

  it('classifies every runtime value kind', () => {
    expect(classifyValue('s')).toBe('string');
    expect(classifyValue(1)).toBe('number');
    expect(classifyValue(true)).toBe('boolean');
    expect(classifyValue(10n)).toBe('bigint');
    expect(classifyValue(new Date())).toBe('Date'); // object → Date
    expect(classifyValue({})).toBe('unknown'); // object → non-Date
    expect(classifyValue(undefined)).toBe('unknown'); // default branch
  });
});

describe('conventions · delete behavior', () => {
  it('required FK cascades, optional FK sets null', () => {
    expect(defaultDeleteBehavior(false)).toBe('cascade');
    expect(defaultDeleteBehavior(true)).toBe('setNull');
  });
});
