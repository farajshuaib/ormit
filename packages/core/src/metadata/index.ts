/** Public metadata surface (plan §5 · S2, Phase 2). */
export * from './types.js';
export {
  ModelBuilder,
  EntityBuilder,
  PropertyBuilder,
  IndexBuilder,
  ReferenceNavigationBuilder,
  CollectionNavigationBuilder,
  DiscriminatorBuilder,
  type Ctor,
} from './builder.js';
export { ModelSnapshot, type EntityMeta } from './snapshot.js';
export {
  serializeSnapshot,
  deserializeSnapshot,
  stableStringify,
} from './serialize.js';
export {
  DIAGNOSTIC_TITLES,
  formatDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
} from './diagnostics.js';
export {
  pluralize,
  tableNameFor,
  columnNameFor,
  capitalize,
  camelCase,
  isKeyByConvention,
  discoverKey,
  foreignKeyCandidates,
  discoverForeignKey,
  ownedColumnName,
  inferClrType,
  classifyValue,
  defaultDeleteBehavior,
} from './conventions.js';
