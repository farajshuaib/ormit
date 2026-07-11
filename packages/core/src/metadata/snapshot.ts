/**
 * `ModelSnapshot` (plan §5 · S2): the immutable, validated, module-cacheable
 * result of finalizing a `ModelBuilder`. It is the single metadata surface the
 * rest of the runtime queries, and it serializes to the byte-stable form the
 * migrations subsystem commits.
 */
import { ModelValidationError, type ModelDiagnostic } from '../errors.js';
import type { ModelBuilder, Ctor } from './builder.js';
import { finalizeModel } from './finalize.js';
import { formatDiagnostic } from './diagnostics.js';
import { deserializeSnapshot, serializeSnapshot } from './serialize.js';
import type { EntitySnapshot, ModelSnapshotData } from './types.js';

/** Back-compatible shape consumed by DbContext/DbSet (the M1 slice). */
export interface EntityMeta {
  readonly name: string;
  readonly table: string;
  readonly key: readonly string[];
}

export class ModelSnapshot {
  private readonly byName: ReadonlyMap<string, EntitySnapshot>;

  private constructor(readonly data: ModelSnapshotData) {
    this.byName = new Map(data.entities.map((e) => [e.name, e]));
  }

  /**
   * Finalize a builder into a validated snapshot. Throws
   * {@link ModelValidationError} carrying every diagnostic if invalid.
   */
  static build(builder: ModelBuilder): ModelSnapshot {
    const { data, diagnostics } = finalizeModel(builder);
    if (diagnostics.length > 0) {
      throw new ModelValidationError(
        `Model is invalid (${diagnostics.length} problem(s)):\n` +
          diagnostics.map((d) => '  - ' + formatDiagnostic(d)).join('\n'),
        diagnostics as readonly ModelDiagnostic[],
      );
    }
    return new ModelSnapshot(data);
  }

  /** Reconstruct a snapshot from its serialized form (no re-validation). */
  static fromJSON(text: string): ModelSnapshot {
    return new ModelSnapshot(deserializeSnapshot(text));
  }

  /** Canonical, sorted-key serialization (byte-stable across a round-trip). */
  toJSON(): string {
    return serializeSnapshot(this.data);
  }

  /** Look up an entity by name, or null. */
  entity(name: string): EntitySnapshot | null {
    return this.byName.get(name) ?? null;
  }

  /** Resolve metadata for a constructor (throws if unregistered). */
  meta<T extends object>(ctor: Ctor<T>): EntityMeta {
    const found = this.byName.get(ctor.name);
    if (!found) {
      throw new ModelValidationError(
        `Entity '${ctor.name}' is not registered. Add it in onModelCreating().`,
      );
    }
    return { name: found.name, table: found.table, key: found.key };
  }

  /** entity name -> table name (the GenContext slice). */
  get tables(): ReadonlyMap<string, string> {
    return new Map(this.data.entities.map((e) => [e.name, e.table]));
  }

  /** All entities in the model, in canonical (name-sorted) order. */
  get entities(): readonly EntitySnapshot[] {
    return this.data.entities;
  }
}
