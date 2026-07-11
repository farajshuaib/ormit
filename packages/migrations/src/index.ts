/** `@ormit/migrations` — model differ, TS emitter, and runner (plan §8). */
export {
  diffSnapshots,
  diffWithDown,
  snapshotData,
  EMPTY_SNAPSHOT,
} from './differ.js';
export { emitMigration, migrationId, type EmittedMigration } from './emitter.js';
export { Migrator, type Migration } from './runner.js';
export { repairSnapshot, type RepairResult } from './repair.js';
