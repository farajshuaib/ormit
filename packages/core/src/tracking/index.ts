/** Change tracking & unit of work (plan §5 · S4). */
export {
  ChangeTracker,
  EntityEntry,
  isScalar,
  scalarEquals,
  scalarSnapshot,
  type EntityState,
  type NavigationLoader,
} from './tracker.js';
export { planSave, topoSort, type SaveStep } from './save.js';
