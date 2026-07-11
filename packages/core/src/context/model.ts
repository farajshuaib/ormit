/**
 * Compatibility surface. The metadata subsystem now lives under
 * `../metadata`; this module re-exports the pieces that `DbContext`/`DbSet`
 * and the package entry point depend on, so those import paths stay stable.
 */
export {
  ModelBuilder,
  EntityBuilder,
  ModelSnapshot,
  type Ctor,
  type EntityMeta,
} from '../metadata/index.js';
