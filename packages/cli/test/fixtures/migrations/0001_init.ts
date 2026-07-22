import type { MigrationOperation } from '@ormit/core';

export const id = '0001_init';
export const up: MigrationOperation[] = [
  {
    kind: 'createTable',
    table: 'widgets',
    schema: null,
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'number', nullable: false, maxLength: null, defaultValue: null, defaultValueSql: null },
    ],
  },
];
export const down: MigrationOperation[] = [{ kind: 'dropTable', table: 'widgets', schema: null }];
