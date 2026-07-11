import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against TypeScript source so coverage is meaningful and there
    // is no stale-dist hazard. `.js` specifiers in source resolve to `.ts`.
    alias: {
      '@ormit/core': src('./packages/core/src/index.ts'),
      '@ormit/testing': src('./packages/testing/src/index.ts'),
      '@ormit/engine-kysely': src('./packages/engine-kysely/src/index.ts'),
      '@ormit/sqlite': src('./packages/dialect-sqlite/src/index.ts'),
      '@ormit/plugins': src('./packages/plugins/src/index.ts'),
      '@ormit/migrations': src('./packages/migrations/src/index.ts'),
      '@ormit/cli': src('./packages/cli/src/index.ts'),
      '@ormit/decorators': src('./packages/decorators/src/index.ts'),
      '@ormit/postgres': src('./packages/dialect-postgres/src/index.ts'),
      '@ormit/mysql': src('./packages/dialect-mysql/src/index.ts'),
      '@ormit/mssql': src('./packages/dialect-mssql/src/index.ts'),
      '@ormit/adapters': src('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/metadata/conventions.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { branches: 100 },
    },
  },
});
