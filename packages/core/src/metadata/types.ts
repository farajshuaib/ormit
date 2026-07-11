/**
 * Serializable model metadata (plan §5 · S2).
 *
 * These are the *finalized* shapes produced after conventions run and
 * validation passes. They are pure JSON — every optional slot is an explicit
 * `null` rather than a missing/`undefined` key so that serialization is
 * deterministic and byte-identical across a round-trip (the Phase 2 gate).
 *
 * The migrations subsystem (Phase 8) consumes `ModelSnapshotData` directly;
 * it never sees the builder objects.
 */

/** JSON values permitted in seed rows / default literals. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** CLR-ish type tag. `unknown` is the honest default until decorators (Phase 7)
 * reflect real property types; conventions may still narrow it (e.g. maxLength
 * ⇒ string). */
export type ClrType = 'string' | 'number' | 'boolean' | 'Date' | 'bigint' | 'unknown';

export type ValueGenerated = 'never' | 'onAdd' | 'onAddOrUpdate';

export type DeleteBehavior = 'cascade' | 'restrict' | 'setNull' | 'noAction';

export interface PropertySnapshot {
  /** JS property name on the entity. */
  readonly name: string;
  /** Physical column name. */
  readonly column: string;
  readonly type: ClrType;
  readonly nullable: boolean;
  readonly maxLength: number | null;
  readonly defaultValue: JsonValue;
  readonly defaultValueSql: string | null;
  readonly concurrencyToken: boolean;
  readonly valueGenerated: ValueGenerated;
  /** Identity of a registered value converter, or null. Functions are never
   * serialized; the converter itself lives in a runtime registry keyed by this
   * name. */
  readonly conversion: string | null;
  readonly comment: string | null;
}

export interface IndexSnapshot {
  readonly name: string;
  readonly properties: readonly string[];
  readonly unique: boolean;
}

export interface NavigationSnapshot {
  /** Navigation property name on the declaring entity. */
  readonly name: string;
  /** Target entity name. */
  readonly target: string;
  readonly collection: boolean;
  /** FK property names on the dependent side. */
  readonly foreignKey: readonly string[];
  /** Principal key property names the FK references. */
  readonly principalKey: readonly string[];
  /** Inverse navigation name on the target, or null. */
  readonly inverse: string | null;
  readonly deleteBehavior: DeleteBehavior;
  /** True when this navigation points at an owned type. */
  readonly owned: boolean;
  /** For many-to-many: the join entity name, else null. */
  readonly joinEntity: string | null;
}

export interface DiscriminatorSnapshot {
  readonly column: string;
  /** Mapped property backing the discriminator, or null (shadow column). */
  readonly property: string | null;
  readonly value: string;
}

export interface EntitySnapshot {
  readonly name: string;
  readonly table: string;
  readonly schema: string | null;
  /** Primary key property names (composite ⇒ length > 1). */
  readonly key: readonly string[];
  readonly properties: readonly PropertySnapshot[];
  readonly navigations: readonly NavigationSnapshot[];
  readonly indexes: readonly IndexSnapshot[];
  /** Global query filter, stored as expression IR (or null). */
  readonly queryFilter: JsonValue;
  readonly seedData: readonly JsonValue[];
  readonly discriminator: DiscriminatorSnapshot | null;
  /** True when this entity is owned by another (no standalone lifecycle). */
  readonly owned: boolean;
}

export interface ModelSnapshotData {
  /** Snapshot format version. Bumped only via ADR (feeds migration compat). */
  readonly version: number;
  readonly entities: readonly EntitySnapshot[];
}

export const SNAPSHOT_VERSION = 1;
