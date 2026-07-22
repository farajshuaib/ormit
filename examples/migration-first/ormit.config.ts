import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { defineConfig } from '@ormit/cli';
import { SqliteEngine } from '@ormit/sqlite';
import { defineModel } from './src/models.js';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  engine: () => {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    return new SqliteEngine(join(dataDir, 'app.db'));
  },
  model: defineModel,
});
