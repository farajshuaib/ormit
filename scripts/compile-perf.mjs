// Compile-time perf gate (plan §9, risk R4): a 50-entity model with typed
// queries must typecheck in under the budget. Generates a fixture that imports
// the built @ormit/core types, runs `tsc --noEmit`, and reports the duration.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTITIES = 50;
const BUDGET_MS = 3000;
const repo = process.cwd();
const coreTypes = join(repo, 'packages/core/dist/index');

let model = `import { recordPredicate, ModelBuilder, ModelSnapshot } from ${JSON.stringify(coreTypes)};\n\n`;
for (let i = 0; i < ENTITIES; i++) {
  model += `class E${i} {\n`;
  model += `  id!: number;\n  name!: string;\n  age!: number;\n  active!: boolean;\n  createdAt!: Date;\n  score!: number;\n}\n`;
}
model += `export function build() {\n  const m = new ModelBuilder();\n`;
for (let i = 0; i < ENTITIES; i++) {
  model += `  m.entity(E${i}, (e) => { e.hasKey('id'); e.property((x) => x.name).hasMaxLength(100); });\n`;
}
model += `  return ModelSnapshot.build(m);\n}\n\n`;
// Exercise the FieldRef/EntityRef type machinery across every entity.
for (let i = 0; i < ENTITIES; i++) {
  model += `export const q${i} = recordPredicate<E${i}>((x) => x.age.gt(18).and(x.name.startsWith('A')).and(x.active.eq(true)).or(x.score.between(1, 9)).and(x.createdAt.lte(new Date())));\n`;
}

const dir = mkdtempSync(join(tmpdir(), 'ormit-perf-'));
writeFileSync(join(dir, 'model.ts'), model);
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['model.ts'],
  }),
);

const tsc = join(repo, 'node_modules/.bin/tsc');
const start = performance.now();
try {
  execFileSync(tsc, ['-p', join(dir, 'tsconfig.json')], { stdio: 'pipe' });
} catch (err) {
  console.error('typecheck failed:\n' + (err.stdout?.toString() ?? err.message));
  process.exit(2);
}
const ms = Math.round(performance.now() - start);
console.log(`compile-perf: ${ENTITIES}-entity model typechecked in ${ms}ms (budget ${BUDGET_MS}ms)`);
if (ms > BUDGET_MS) {
  console.error(`FAIL: exceeded ${BUDGET_MS}ms budget`);
  process.exit(1);
}
