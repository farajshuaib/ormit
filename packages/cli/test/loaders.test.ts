import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTsModule } from '../src/ts-loader.js';
import { loadConfig } from '../src/load-config.js';
import { loadMigrations } from '../src/load-migrations.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('loadTsModule', () => {
  it('bundles a .ts file, resolving both a relative import and a bare node_modules import', async () => {
    const path = fileURLToPath(new URL('./fixtures/ormit.config.ts', import.meta.url));
    const mod = await loadTsModule<{ default: unknown; proof: object; ownDirectory: string }>(path, {
      bundle: true,
    });
    // If the bundler's temp file were written outside the project tree (e.g.
    // os.tmpdir()), this bare-specifier import would throw ERR_MODULE_NOT_FOUND
    // before we ever got here — reaching this assertion is the regression test.
    // (Can't assert `instanceof ModelBuilder` here: this loads @ormit/core via
    // real Node resolution against the compiled dist, a different module
    // realm than the one vitest's own transform gives this test file — so we
    // check the shape instead of class identity.)
    expect(mod.proof.constructor.name).toBe('ModelBuilder');
    expect(mod.default).toBeTruthy();
    // The transpiled file must be colocated with the original — otherwise the
    // fixture's own `dirname(fileURLToPath(import.meta.url))` (the standard
    // idiom for building robust relative paths) would report the wrong
    // directory (e.g. a shared temp folder instead of FIXTURES).
    expect(mod.ownDirectory).toBe(FIXTURES.replace(/[/\\]$/, ''));
  });

  it('type-strips a .ts file without bundling (the migration-file path)', async () => {
    const path = fileURLToPath(new URL('./fixtures/migrations/0001_init.ts', import.meta.url));
    const mod = await loadTsModule<{ id: string; up: unknown[]; down: unknown[] }>(path);
    expect(mod.id).toBe('0001_init');
    expect(mod.up).toHaveLength(1);
  });
});

describe('loadConfig', () => {
  it('resolves and loads ormit.config.ts from a directory', async () => {
    const { config, root } = await loadConfig(undefined, FIXTURES);
    expect(typeof config.engine).toBe('function');
    expect(typeof config.model).toBe('function');
    expect(config.migrationsDir).toBe('./migrations');
    expect(root).toBe(FIXTURES.replace(/[/\\]$/, ''));
  });

  it('throws a clear error when no config file exists in the directory', async () => {
    const empty = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));
    await expect(loadConfig(undefined, empty)).rejects.toThrow(/no ormit config found/i);
  });

  it('respects an explicit path over the search order', async () => {
    const explicit = fileURLToPath(new URL('./fixtures/ormit.config.ts', import.meta.url));
    const { config } = await loadConfig(explicit, '/nonexistent/dir/that/does/not/matter');
    expect(typeof config.engine).toBe('function');
  });
});

describe('loadMigrations', () => {
  it('loads migration files sorted by filename and tracks id -> path', async () => {
    const dir = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));
    const { migrations, filenameOf } = await loadMigrations(dir);
    expect(migrations.map((m) => m.id)).toEqual(['0001_init', '0002_add_col']);
    expect(filenameOf('0001_init')).toContain('0001_init.ts');
    expect(filenameOf('nonexistent')).toBeUndefined();
  });

  it('returns an empty list when the directory does not exist', async () => {
    const { migrations, filenameOf } = await loadMigrations('/nonexistent/migrations/dir');
    expect(migrations).toEqual([]);
    expect(filenameOf('anything')).toBeUndefined();
  });
});
