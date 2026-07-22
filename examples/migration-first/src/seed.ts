/**
 * Proves the migrated database actually works: insert through the tracked
 * DbContext, then query it back with an Include. Run after `pnpm db:update`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteEngine } from '@ormit/sqlite';
import { AppDb } from './db.js';
import { User, Post } from './models.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = join(root, 'data', 'app.db');

async function main(): Promise<void> {
  const engine = new SqliteEngine(dbPath);
  const db = new AppDb({ engine });

  const author = db.users.add(Object.assign(new User(), { name: 'Faraj', email: 'faraj@example.com' }));
  await db.saveChanges(); // author.id is written back here

  db.posts.add(
    Object.assign(new Post(), {
      title: 'Hello, Ormit',
      body: 'Migration-first, for real.',
      authorId: author.id,
    }),
  );
  await db.saveChanges();

  const users = await db.users.include((x) => x.posts).toList();
  for (const user of users) {
    console.log(`${user.name} <${user.email}>`);
    for (const post of user.posts) console.log(`  - ${post.title}`);
  }

  await db[Symbol.asyncDispose]();
  engine.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
