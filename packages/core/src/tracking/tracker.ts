/**
 * Change tracking (plan §5 · S4, Phase 5).
 *
 * Snapshot diffing + an identity map over POCO entities (ADR-005). Each tracked
 * entity has an {@link EntityEntry} holding its state and a snapshot of scalar
 * values taken at the last "accept". `detectChanges` diffs current values
 * against that snapshot to move Unchanged → Modified.
 */
import type { ModelSnapshot } from '../metadata/snapshot.js';

export type EntityState = 'Detached' | 'Added' | 'Unchanged' | 'Modified' | 'Deleted';

/** A value that lives in a column (everything else is a navigation). */
export function isScalar(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return true;
  return value instanceof Date;
}

export function scalarEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Copy an entity's scalar (column-backed) properties. */
export function scalarSnapshot(entity: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (isScalar(value)) out[key] = value instanceof Date ? new Date(value.getTime()) : value;
  }
  return out;
}

export interface NavigationLoader {
  load(): Promise<void>;
}

export class EntityEntry<T extends object = object> {
  /** @internal — set by the context to enable explicit loading. */
  loader?: (navigation: string) => Promise<void>;

  /** @internal */
  constructor(
    readonly entity: T,
    readonly entityName: string,
    public state: EntityState,
    public snapshot: Record<string, unknown>,
  ) {}

  /** Explicitly load a reference navigation: `entry.reference('author').load()`. */
  reference(navigation: string): NavigationLoader {
    return { load: () => this.loader?.(navigation) ?? Promise.resolve() };
  }
  /** Explicitly load a collection navigation. */
  collection(navigation: string): NavigationLoader {
    return { load: () => this.loader?.(navigation) ?? Promise.resolve() };
  }

  /** Scalar property names whose value differs from the snapshot. */
  modifiedProperties(): string[] {
    const current = this.entity as Record<string, unknown>;
    const changed: string[] = [];
    const names = new Set([...Object.keys(this.snapshot), ...Object.keys(current)]);
    for (const name of names) {
      const value = current[name];
      if (!isScalar(value)) continue; // navigations aren't diffed here
      if (!scalarEquals(value, this.snapshot[name])) changed.push(name);
    }
    return changed;
  }

  currentValues(): Record<string, unknown> {
    return scalarSnapshot(this.entity);
  }

  /** @internal — reset the baseline after a successful save. */
  refreshSnapshot(): void {
    this.snapshot = scalarSnapshot(this.entity);
  }
}

export class ChangeTracker {
  private readonly byRef = new Map<object, EntityEntry>();
  private readonly identityMap = new Map<string, EntityEntry>();

  constructor(private readonly model: ModelSnapshot) {}

  private keyProps(entityName: string): readonly string[] {
    return this.model.entity(entityName)?.key ?? ['id'];
  }

  private identityKey(entityName: string, entity: object): string | null {
    const values = this.keyProps(entityName).map((k) => (entity as Record<string, unknown>)[k]);
    if (values.some((v) => v === undefined || v === null)) return null;
    return keyString(entityName, values);
  }

  entry(entity: object): EntityEntry | undefined {
    return this.byRef.get(entity);
  }

  allEntries(): readonly EntityEntry[] {
    return [...this.byRef.values()];
  }

  entriesInState(state: EntityState): EntityEntry[] {
    return [...this.byRef.values()].filter((e) => e.state === state);
  }

  hasChanges(): boolean {
    return [...this.byRef.values()].some(
      (e) => e.state === 'Added' || e.state === 'Modified' || e.state === 'Deleted',
    );
  }

  /** Track (or re-state) an entity by reference. */
  track<T extends object>(entity: T, entityName: string, state: EntityState): EntityEntry<T> {
    const existing = this.byRef.get(entity);
    if (existing) {
      existing.state = state;
      return existing as EntityEntry<T>;
    }
    const entry = new EntityEntry<T>(entity, entityName, state, scalarSnapshot(entity));
    this.byRef.set(entity, entry as EntityEntry);
    const key = this.identityKey(entityName, entity);
    if (key) this.identityMap.set(key, entry as EntityEntry);
    return entry;
  }

  /** Register a freshly materialized entity, deduped through the identity map. */
  registerQueried<T extends object>(entity: T, entityName: string): T {
    const key = this.identityKey(entityName, entity);
    if (key) {
      const existing = this.identityMap.get(key);
      if (existing) return existing.entity as T; // canonical, keeps in-flight edits
    }
    this.track(entity, entityName, 'Unchanged');
    return entity;
  }

  findByKey(entityName: string, keyValues: readonly unknown[]): object | undefined {
    return this.identityMap.get(keyString(entityName, keyValues))?.entity;
  }

  /** Added + remove ⇒ Detached; otherwise mark Deleted. */
  remove(entity: object, entityName: string): void {
    const entry = this.byRef.get(entity);
    if (!entry) {
      this.track(entity, entityName, 'Deleted');
      return;
    }
    if (entry.state === 'Added') this.detach(entry);
    else entry.state = 'Deleted';
  }

  detach(entry: EntityEntry): void {
    this.byRef.delete(entry.entity);
    const key = this.identityKey(entry.entityName, entry.entity);
    if (key) this.identityMap.delete(key);
    entry.state = 'Detached';
  }

  /** Diff snapshots: move Unchanged/Modified entries to their real state. */
  detectChanges(): void {
    for (const entry of this.byRef.values()) {
      if (entry.state === 'Unchanged' || entry.state === 'Modified') {
        entry.state = entry.modifiedProperties().length > 0 ? 'Modified' : 'Unchanged';
      }
    }
  }

  /** After a successful save: refresh snapshots, drop deleted, re-key inserts. */
  acceptChanges(): void {
    for (const entry of [...this.byRef.values()]) {
      if (entry.state === 'Deleted') {
        this.detach(entry);
      } else if (entry.state === 'Added' || entry.state === 'Modified') {
        entry.state = 'Unchanged';
        entry.refreshSnapshot();
        const key = this.identityKey(entry.entityName, entry.entity);
        if (key) this.identityMap.set(key, entry);
      }
    }
  }

  clear(): void {
    this.byRef.clear();
    this.identityMap.clear();
  }
}

function keyString(entityName: string, values: readonly unknown[]): string {
  return entityName + '|' + JSON.stringify(values.map((v) => (v instanceof Date ? v.getTime() : v)));
}
