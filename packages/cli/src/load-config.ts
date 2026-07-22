/**
 * Resolves and loads `ormit.config.{ts,mts,js,mjs}` from a directory (default
 * `process.cwd()`), or an explicit path passed via `--config`.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { OrmitConfig } from './config.js';
import { loadTsModule } from './ts-loader.js';

const CANDIDATES = ['ormit.config.ts', 'ormit.config.mts', 'ormit.config.js', 'ormit.config.mjs'];

export interface LoadedConfig {
  readonly config: OrmitConfig;
  /** Directory the config file lives in — relative paths in the config
   * (migrationsDir, snapshotPath) resolve against this, not the cwd. */
  readonly root: string;
}

function resolveConfigPath(explicit: string | undefined, cwd: string): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  for (const name of CANDIDATES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No ormit config found in '${cwd}'. Create one of: ${CANDIDATES.join(', ')} — or pass --config <path>.`,
  );
}

export async function loadConfig(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): Promise<LoadedConfig> {
  const path = resolveConfigPath(explicit, cwd);
  const mod = await loadTsModule<{ default?: OrmitConfig }>(path, { bundle: true });
  const config = mod.default;
  if (!config || typeof config.engine !== 'function' || typeof config.model !== 'function') {
    throw new Error(
      `'${path}' must have a default export from defineConfig({ engine, model, ... }).`,
    );
  }
  return { config, root: dirname(path) };
}
