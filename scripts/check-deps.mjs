// Dependency-rule gate (plan §2). Fails the build on violations.
// Rule 1: @ormit/core imports nothing from the workspace and nothing from kysely.
// Rule 2: dialect/other packages never import 'kysely' directly (only engine-kysely may).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const violations = [];
function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, fn);
    else if (p.endsWith('.ts')) fn(p);
  }
}
function importsOf(file) {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

walk('packages/core/src', (f) => {
  for (const spec of importsOf(f)) {
    if (spec.startsWith('@ormit/') || spec === 'kysely')
      violations.push(`${f}: core must not import '${spec}'`);
  }
});
for (const pkg of readdirSync('packages')) {
  if (pkg === 'engine-kysely') continue;
  const src = join('packages', pkg, 'src');
  try { statSync(src); } catch { continue; }
  walk(src, (f) => {
    for (const spec of importsOf(f)) {
      if (spec === 'kysely') violations.push(`${f}: only engine-kysely may import 'kysely'`);
    }
  });
}
if (violations.length) {
  console.error('Dependency rule violations:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('dependency rules: OK');
