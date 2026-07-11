/**
 * Model-validation diagnostics (plan §5 · S2; error codes `OMT12xx`).
 *
 * Every diagnostic has a stable code, a one-line title, and a message built
 * from context. The catalog below is the single source of truth mirrored in
 * `docs/diagnostics.md`; the Phase 2 gate asserts that each curated
 * invalid-model fixture surfaces its documented code.
 */

export type DiagnosticCode =
  | 'OMT1201' // entity has no primary key
  | 'OMT1202' // key property collides with a navigation name
  | 'OMT1203' // entity registered more than once
  | 'OMT1204' // two entities mapped to the same table
  | 'OMT1205' // duplicate column name within an entity
  | 'OMT1206' // hasMaxLength given a non-positive/non-integer value
  | 'OMT1207' // foreign key arity does not match the principal key
  | 'OMT1208' // foreign key could not be found or discovered
  | 'OMT1209' // discriminator value used by more than one entity
  | 'OMT1210' // composite key lists the same property twice
  | 'OMT1211' // seed row is missing a key value
  | 'OMT1212' // seed row references an unknown property
  | 'OMT1213' // index references an unknown property
  | 'OMT1214' // index declares no properties
  | 'OMT1215' // hasConversion given an empty converter name
  | 'OMT1216' // owned type declares its own explicit key
  | 'OMT1217' // hasColumnName given an empty string
  | 'OMT1218' // a key property is also marked a concurrency token
  | 'OMT1219' // toTable given an empty name
  | 'OMT1220' // many-to-many join entity is not in the model
  | 'OMT1221' // navigation name collides with a scalar property
  | 'OMT1222' // discriminator declared without a value for the entity
  | 'OMT1223'; // hasDefault and hasDefaultSql both set on one property

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  /** Entity the diagnostic is attached to, when applicable. */
  readonly entity?: string;
  /** Property/navigation the diagnostic is attached to, when applicable. */
  readonly member?: string;
}

/** One-line human title per code (documented in docs/diagnostics.md). */
export const DIAGNOSTIC_TITLES: Readonly<Record<DiagnosticCode, string>> = {
  OMT1201: 'Entity has no primary key',
  OMT1202: 'Key property collides with a navigation name',
  OMT1203: 'Entity registered more than once',
  OMT1204: 'Two entities mapped to the same table',
  OMT1205: 'Duplicate column name within an entity',
  OMT1206: 'hasMaxLength must be a positive integer',
  OMT1207: 'Foreign key arity does not match the principal key',
  OMT1208: 'Foreign key could not be resolved',
  OMT1209: 'Discriminator value is not unique',
  OMT1210: 'Composite key lists a property twice',
  OMT1211: 'Seed row is missing a key value',
  OMT1212: 'Seed row references an unknown property',
  OMT1213: 'Index references an unknown property',
  OMT1214: 'Index declares no properties',
  OMT1215: 'hasConversion requires a converter name',
  OMT1216: 'Owned type may not declare its own key',
  OMT1217: 'hasColumnName requires a non-empty name',
  OMT1218: 'A key property cannot be a concurrency token',
  OMT1219: 'toTable requires a non-empty name',
  OMT1220: 'Many-to-many join entity is not in the model',
  OMT1221: 'Navigation name collides with a scalar property',
  OMT1222: 'Discriminator declared without a value',
  OMT1223: 'hasDefault and hasDefaultSql are mutually exclusive',
};

export function diagnostic(
  code: DiagnosticCode,
  message: string,
  context?: { entity?: string; member?: string },
): Diagnostic {
  return {
    code,
    message,
    ...(context?.entity !== undefined ? { entity: context.entity } : {}),
    ...(context?.member !== undefined ? { member: context.member } : {}),
  };
}

/** Render a diagnostic to a single actionable line. */
export function formatDiagnostic(d: Diagnostic): string {
  const where =
    d.entity !== undefined
      ? d.member !== undefined
        ? ` (${d.entity}.${d.member})`
        : ` (${d.entity})`
      : '';
  return `${d.code}: ${d.message}${where}`;
}
