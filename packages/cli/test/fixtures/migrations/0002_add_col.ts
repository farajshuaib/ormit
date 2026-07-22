import type { MigrationOperation } from '@ormit/core';

export const id = '0002_add_col';
export const up: MigrationOperation[] = [
  {
    kind: 'addColumn',
    table: 'widgets',
    column: { name: 'label', type: 'string', nullable: true, maxLength: 50, defaultValue: null, defaultValueSql: null },
  },
];
export const down: MigrationOperation[] = [{ kind: 'dropColumn', table: 'widgets', column: 'label' }];
