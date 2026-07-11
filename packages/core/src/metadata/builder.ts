/**
 * Fluent model configuration (plan §3 FROZEN surface; Phase 2).
 *
 * The builders record *raw* user intent — exactly what was configured, with no
 * conventions applied. Finalization (`finalize.ts`) later merges conventions
 * into the gaps and validates. Decorators (Phase 7) replay into this very same
 * surface, which is why precedence is `convention < decorator < fluent`.
 */
import type { BoolExprNode } from '../ir/nodes.js';
import {
  recordPath,
  recordPredicate,
  type BoolExpr,
  type EntityRef,
} from '../expressions/recorder.js';
import type { ClrType, DeleteBehavior, JsonValue, ValueGenerated } from './types.js';

export type Ctor<T> = new (...args: never[]) => T;

// ---------------------------------------------------------------------------
// Raw (pre-convention) configuration records
// ---------------------------------------------------------------------------

export interface RawProperty {
  readonly name: string;
  column?: string;
  type?: ClrType;
  nullable?: boolean;
  maxLength?: number;
  hasDefault?: boolean;
  defaultValue?: JsonValue;
  defaultValueSql?: string;
  concurrencyToken?: boolean;
  valueGenerated?: ValueGenerated;
  conversion?: string;
  comment?: string;
}

export interface RawIndex {
  readonly properties: readonly string[];
  unique: boolean;
  name?: string;
}

export interface RawNavigation {
  readonly name: string;
  readonly targetCtor: Ctor<object>;
  readonly collection: boolean;
  owned: boolean;
  foreignKey?: readonly string[];
  principalKey?: readonly string[];
  inverseName?: string;
  inverseCollection?: boolean;
  deleteBehavior?: DeleteBehavior;
  required?: boolean;
  joinCtor?: Ctor<object>;
}

export interface RawDiscriminator {
  column: string;
  property?: string;
  value?: string;
}

export interface RawEntity {
  readonly ctor: Ctor<object>;
  readonly name: string;
  table?: string;
  schema?: string;
  key?: readonly string[];
  keyExplicit: boolean;
  ownedExplicit: boolean;
  owned: boolean;
  readonly properties: Map<string, RawProperty>;
  readonly navigations: RawNavigation[];
  readonly indexes: RawIndex[];
  readonly seedData: JsonValue[];
  queryFilter?: BoolExprNode;
  discriminator?: RawDiscriminator;
}

function newRawEntity(ctor: Ctor<object>): RawEntity {
  return {
    ctor,
    name: ctor.name,
    keyExplicit: false,
    ownedExplicit: false,
    owned: false,
    properties: new Map(),
    navigations: [],
    indexes: [],
    seedData: [],
  };
}

/** Shared registry so relationship/owned builders can reach other entities. */
export interface BuilderRegistry {
  getOrCreate(ctor: Ctor<object>): RawEntity;
}

// ---------------------------------------------------------------------------
// PropertyBuilder
// ---------------------------------------------------------------------------

export class PropertyBuilder<V> {
  /** @internal */
  constructor(private readonly raw: RawProperty) {}

  hasColumnName(name: string): this {
    this.raw.column = name;
    return this;
  }
  hasMaxLength(length: number): this {
    this.raw.maxLength = length;
    return this;
  }
  hasType(type: ClrType): this {
    this.raw.type = type;
    return this;
  }
  isRequired(required = true): this {
    this.raw.nullable = !required;
    return this;
  }
  hasDefault(value: V & JsonValue): this {
    this.raw.hasDefault = true;
    this.raw.defaultValue = value;
    return this;
  }
  hasDefaultSql(sql: string): this {
    this.raw.defaultValueSql = sql;
    return this;
  }
  hasConversion(converterName: string): this {
    this.raw.conversion = converterName;
    return this;
  }
  isConcurrencyToken(isToken = true): this {
    this.raw.concurrencyToken = isToken;
    return this;
  }
  valueGenerated(kind: ValueGenerated): this {
    this.raw.valueGenerated = kind;
    return this;
  }
  hasComment(comment: string): this {
    this.raw.comment = comment;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Relationship builders
// ---------------------------------------------------------------------------

export class ReferenceNavigationBuilder<T extends object, N extends object> {
  /** @internal */
  constructor(
    private readonly nav: RawNavigation,
    private readonly targetName: string,
  ) {}

  /** The inverse side is a collection (one-principal → many-dependents). */
  withMany(inverse?: (x: EntityRef<N>) => unknown): this {
    this.nav.inverseCollection = true;
    if (inverse) this.nav.inverseName = firstSegment(recordPath(inverse), this.targetName);
    return this;
  }
  /** The inverse side is a single reference (one-to-one). */
  withOne(inverse?: (x: EntityRef<N>) => unknown): this {
    this.nav.inverseCollection = false;
    if (inverse) this.nav.inverseName = firstSegment(recordPath(inverse), this.targetName);
    return this;
  }
  hasForeignKey(...properties: string[]): this {
    this.nav.foreignKey = properties;
    return this;
  }
  hasPrincipalKey(...properties: string[]): this {
    this.nav.principalKey = properties;
    return this;
  }
  onDelete(behavior: DeleteBehavior): this {
    this.nav.deleteBehavior = behavior;
    return this;
  }
  isRequired(required = true): this {
    this.nav.required = required;
    return this;
  }
}

export class CollectionNavigationBuilder<T extends object, N extends object> {
  /** @internal */
  constructor(
    private readonly nav: RawNavigation,
    private readonly targetName: string,
  ) {}

  /** The inverse side is a single reference (one-to-many). */
  withOne(inverse?: (x: EntityRef<N>) => unknown): this {
    this.nav.inverseCollection = false;
    if (inverse) this.nav.inverseName = firstSegment(recordPath(inverse), this.targetName);
    return this;
  }
  /** Many-to-many; optionally routed through an explicit join entity. */
  withMany(
    inverse?: (x: EntityRef<N>) => unknown,
    usingEntity?: Ctor<object>,
  ): this {
    this.nav.inverseCollection = true;
    if (inverse) this.nav.inverseName = firstSegment(recordPath(inverse), this.targetName);
    if (usingEntity) this.nav.joinCtor = usingEntity;
    return this;
  }
  hasForeignKey(...properties: string[]): this {
    this.nav.foreignKey = properties;
    return this;
  }
  onDelete(behavior: DeleteBehavior): this {
    this.nav.deleteBehavior = behavior;
    return this;
  }
}

export class DiscriminatorBuilder {
  /** @internal */
  constructor(private readonly disc: RawDiscriminator) {}
  hasValue(value: string): this {
    this.disc.value = value;
    return this;
  }
}

// ---------------------------------------------------------------------------
// EntityBuilder
// ---------------------------------------------------------------------------

export class EntityBuilder<T extends object> {
  /** @internal */
  constructor(
    private readonly raw: RawEntity,
    private readonly registry: BuilderRegistry,
  ) {}

  toTable(name: string, schema?: string): this {
    this.raw.table = name;
    if (schema !== undefined) this.raw.schema = schema;
    return this;
  }

  hasKey(...properties: (keyof T & string)[]): this {
    this.raw.key = properties;
    this.raw.keyExplicit = true;
    return this;
  }

  property<K extends keyof T & string>(
    selector: (x: EntityRef<T>) => unknown,
  ): PropertyBuilder<T[K]> {
    const name = onlySegment(recordPath(selector));
    return new PropertyBuilder<T[K]>(this.rawProperty(name));
  }

  hasIndex(...properties: (keyof T & string)[]): IndexBuilder {
    const index: RawIndex = { properties, unique: false };
    this.raw.indexes.push(index);
    return new IndexBuilder(index);
  }

  hasQueryFilter(predicate: (x: EntityRef<T>) => BoolExpr): this {
    this.raw.queryFilter = recordPredicate(predicate);
    return this;
  }

  hasData(...rows: Partial<T>[]): this {
    for (const row of rows) this.raw.seedData.push(row as JsonValue);
    return this;
  }

  hasDiscriminator(column: string, value?: string): DiscriminatorBuilder {
    const disc: RawDiscriminator = { column };
    if (value !== undefined) disc.value = value;
    this.raw.discriminator = disc;
    return new DiscriminatorBuilder(disc);
  }

  hasOne<N extends object>(
    target: Ctor<N>,
    navigation: (x: EntityRef<T>) => unknown,
  ): ReferenceNavigationBuilder<T, N> {
    const nav = this.addNavigation(target, navigation, false, false);
    return new ReferenceNavigationBuilder<T, N>(nav, target.name);
  }

  hasMany<N extends object>(
    target: Ctor<N>,
    navigation: (x: EntityRef<T>) => unknown,
  ): CollectionNavigationBuilder<T, N> {
    const nav = this.addNavigation(target, navigation, true, false);
    return new CollectionNavigationBuilder<T, N>(nav, target.name);
  }

  ownsOne<N extends object>(
    target: Ctor<N>,
    navigation: (x: EntityRef<T>) => unknown,
    build?: (e: EntityBuilder<N>) => void,
  ): this {
    return this.configureOwned(target, navigation, false, build);
  }

  ownsMany<N extends object>(
    target: Ctor<N>,
    navigation: (x: EntityRef<T>) => unknown,
    build?: (e: EntityBuilder<N>) => void,
  ): this {
    return this.configureOwned(target, navigation, true, build);
  }

  // -- internals ------------------------------------------------------------

  private configureOwned<N extends object>(
    target: Ctor<N>,
    navigation: (x: EntityRef<T>) => unknown,
    collection: boolean,
    build?: (e: EntityBuilder<N>) => void,
  ): this {
    this.addNavigation(target, navigation, collection, true);
    const ownedRaw = this.registry.getOrCreate(target as Ctor<object>);
    ownedRaw.owned = true;
    ownedRaw.ownedExplicit = true;
    if (build) build(new EntityBuilder<N>(ownedRaw, this.registry));
    return this;
  }

  private addNavigation(
    target: Ctor<object>,
    selector: (x: EntityRef<T>) => unknown,
    collection: boolean,
    owned: boolean,
  ): RawNavigation {
    const name = onlySegment(recordPath(selector));
    const nav: RawNavigation = { name, targetCtor: target, collection, owned };
    this.raw.navigations.push(nav);
    // Ensure the target participates in the model even if only referenced.
    this.registry.getOrCreate(target);
    return nav;
  }

  private rawProperty(name: string): RawProperty {
    const existing = this.raw.properties.get(name);
    if (existing) return existing;
    const created: RawProperty = { name };
    this.raw.properties.set(name, created);
    return created;
  }
}

export class IndexBuilder {
  /** @internal */
  constructor(private readonly raw: RawIndex) {}
  isUnique(unique = true): this {
    this.raw.unique = unique;
    return this;
  }
  hasName(name: string): this {
    this.raw.name = name;
    return this;
  }
}

// ---------------------------------------------------------------------------
// ModelBuilder
// ---------------------------------------------------------------------------

export class ModelBuilder implements BuilderRegistry {
  private readonly entities = new Map<Ctor<object>, RawEntity>();
  /** Ctors seen via `entity()` (vs. only auto-registered by reference). */
  private readonly declared = new Set<Ctor<object>>();
  private readonly duplicates = new Set<Ctor<object>>();

  entity<T extends object>(ctor: Ctor<T>, build?: (e: EntityBuilder<T>) => void): void {
    const key = ctor as Ctor<object>;
    const raw = this.getOrCreate(key);
    // A second explicit registration of the same entity is a mistake.
    if (this.declared.has(key)) this.duplicates.add(key);
    this.declared.add(key);
    if (build) build(new EntityBuilder<T>(raw, this));
  }

  /** Apply extra configuration to an already-declared entity without counting
   * as a re-registration. Intended for plugins (`configureModel`). */
  configure<T extends object>(ctor: Ctor<T>, build: (e: EntityBuilder<T>) => void): void {
    const raw = this.getOrCreate(ctor as Ctor<object>);
    build(new EntityBuilder<T>(raw, this));
  }

  /** @internal — BuilderRegistry */
  getOrCreate(ctor: Ctor<object>): RawEntity {
    const existing = this.entities.get(ctor);
    if (existing) return existing;
    const created = newRawEntity(ctor);
    this.entities.set(ctor, created);
    return created;
  }

  /** @internal — raw entities in insertion order. */
  rawEntities(): readonly RawEntity[] {
    return [...this.entities.values()];
  }

  /** @internal — ctors registered more than once via `entity()`. */
  duplicateCtors(): ReadonlySet<Ctor<object>> {
    return this.duplicates;
  }

  /** @internal — resolve a ctor to its raw entity name (or null). */
  nameOf(ctor: Ctor<object>): string | null {
    return this.entities.get(ctor)?.name ?? null;
  }

  /** Constructors declared via `entity()` — lets plugins apply model-wide
   * configuration (e.g. a soft-delete filter on every entity). */
  declaredCtors(): readonly Ctor<object>[] {
    return [...this.declared];
  }
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

/** Require a single-segment path (a direct property/navigation selector). */
function onlySegment(path: readonly string[]): string {
  const seg = path[0];
  if (seg === undefined) {
    throw new Error('Selector must access exactly one property.');
  }
  return seg;
}

/** First path segment, falling back to a target-derived name if empty. */
function firstSegment(path: readonly string[], fallback: string): string {
  return path[0] ?? fallback;
}
