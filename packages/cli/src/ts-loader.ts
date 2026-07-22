/**
 * Loads a TS/JS module at runtime for the `ormit` binary, without requiring the
 * consumer to have `tsx`/`ts-node` registered. Plain `.js`/`.mjs` files are
 * imported directly; `.ts`/`.mts` files are transpiled with esbuild first.
 *
 * The transpiled output is written to a temp file in the *same directory* as
 * the source file — never `os.tmpdir()`, and not some other anchor point.
 * Two things depend on this:
 *  - bare specifiers (`import { SqliteEngine } from '@ormit/sqlite'`) resolve
 *    by Node walking up `node_modules` directories from the *importing file's
 *    own path* — a temp file outside the project tree would never find them;
 *  - `import.meta.url`-based paths inside the user's own config/migration code
 *    (the standard `dirname(fileURLToPath(import.meta.url))` idiom) only stay
 *    correct if the running file sits where the source file actually lives —
 *    relocating it to some other directory (even one still inside the
 *    project, like a shared node_modules/.ormit/tmp/) silently breaks that.
 * Colocating solves both at once: it's exactly as resolvable as the original
 * file, and it *is*, for `import.meta.url`'s purposes, the original file's location.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';

const TS_EXTENSIONS = new Set(['.ts', '.mts']);

async function transpile(absPath: string, bundle: boolean): Promise<string> {
  if (bundle) {
    const result = await build({
      entryPoints: [absPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      target: 'node18',
    });
    return result.outputFiles[0]!.text;
  }
  const result = await transform(readFileSync(absPath, 'utf8'), { loader: 'ts', format: 'esm' });
  return result.code;
}

export interface LoadTsModuleOptions {
  /** Bundle local/relative imports together — needed for a config file that
   * imports your own model/engine setup. Default: false, a single-file
   * type-strip, correct for self-contained files like emitted migrations
   * (their only import is a fully-erased `import type`) but still safe for a
   * migration a human has since edited to add real imports: it goes through
   * the same colocated-temp-file mechanism either way, just without bundling
   * anything beyond the one file. */
  readonly bundle?: boolean;
}

/** Import a `.ts`/`.mts`/`.js`/`.mjs` file as an ES module, transpiling if needed. */
export async function loadTsModule<T>(
  absPath: string,
  options: LoadTsModuleOptions = {},
): Promise<T> {
  if (!TS_EXTENSIONS.has(extname(absPath))) {
    return (await import(pathToFileURL(absPath).href)) as T;
  }

  const code = await transpile(absPath, options.bundle ?? false);
  const tmpFile = join(dirname(absPath), `.ormit-tmp-${randomBytes(8).toString('hex')}.mjs`);
  writeFileSync(tmpFile, code);
  try {
    return (await import(pathToFileURL(tmpFile).href)) as T;
  } finally {
    rmSync(tmpFile, { force: true });
  }
}
