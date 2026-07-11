/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `@ormit/decorators` (plan §2, Phase 9): a decorator surface that *replays*
 * into a `ModelBuilder`, keeping precedence `convention < decorator < fluent`.
 *
 * These are legacy-style decorators (they receive `target, propertyKey`) so
 * they also work when invoked as plain functions — no runtime metadata
 * reflection is required. Consumers apply `applyDecorators(model)` inside
 * `onModelCreating`; any subsequent fluent configuration overrides them.
 */
import type { ClrType, Ctor, EntityBuilder, ModelBuilder } from '@ormit/core';

interface PropertyMeta {
  name: string;
  isKey?: boolean;
  column?: string;
  type?: ClrType;
  maxLength?: number;
  required?: boolean;
  concurrency?: boolean;
}
interface RelationMeta {
  name: string;
  kind: 'hasOne' | 'hasMany';
  target: () => Ctor<object>;
  foreignKey?: string;
}
interface EntityMeta {
  ctor: Ctor<object>;
  declared: boolean;
  table?: string;
  properties: Map<string, PropertyMeta>;
  relations: RelationMeta[];
}

const registry = new Map<Ctor<object>, EntityMeta>();

function metaFor(ctor: Ctor<object>): EntityMeta {
  let meta = registry.get(ctor);
  if (!meta) {
    meta = { ctor, declared: false, properties: new Map(), relations: [] };
    registry.set(ctor, meta);
  }
  return meta;
}
function propMeta(ctor: Ctor<object>, name: string): PropertyMeta {
  const meta = metaFor(ctor);
  let p = meta.properties.get(name);
  if (!p) {
    p = { name };
    meta.properties.set(name, p);
  }
  return p;
}
const ctorOf = (target: object): Ctor<object> =>
  (typeof target === 'function' ? target : target.constructor) as Ctor<object>;

// ---- Decorators -----------------------------------------------------------

export interface EntityOptions {
  table?: string;
}
export function entity(options: EntityOptions = {}) {
  return (ctor: Ctor<object>): void => {
    const meta = metaFor(ctor);
    meta.declared = true;
    if (options.table) meta.table = options.table;
  };
}

export function key() {
  return (target: object, propertyKey: string): void => {
    propMeta(ctorOf(target), propertyKey).isKey = true;
  };
}

export interface ColumnOptions {
  name?: string;
  type?: ClrType;
  maxLength?: number;
  required?: boolean;
  concurrencyToken?: boolean;
}
export function column(options: ColumnOptions = {}) {
  return (target: object, propertyKey: string): void => {
    const p = propMeta(ctorOf(target), propertyKey);
    if (options.name !== undefined) p.column = options.name;
    if (options.type !== undefined) p.type = options.type;
    if (options.maxLength !== undefined) p.maxLength = options.maxLength;
    if (options.required !== undefined) p.required = options.required;
    if (options.concurrencyToken !== undefined) p.concurrency = options.concurrencyToken;
  };
}

export interface RelationOptions {
  foreignKey?: string;
}
export function hasMany(target: () => Ctor<object>, options: RelationOptions = {}) {
  return (owner: object, propertyKey: string): void => {
    metaFor(ctorOf(owner)).relations.push({
      name: propertyKey,
      kind: 'hasMany',
      target,
      ...(options.foreignKey ? { foreignKey: options.foreignKey } : {}),
    });
  };
}
export function hasOne(target: () => Ctor<object>, options: RelationOptions = {}) {
  return (owner: object, propertyKey: string): void => {
    metaFor(ctorOf(owner)).relations.push({
      name: propertyKey,
      kind: 'hasOne',
      target,
      ...(options.foreignKey ? { foreignKey: options.foreignKey } : {}),
    });
  };
}

// ---- Replay ---------------------------------------------------------------

/** Replay decorator metadata into a ModelBuilder. Call inside onModelCreating,
 * before any fluent overrides. */
export function applyDecorators(model: ModelBuilder, ctors?: readonly Ctor<object>[]): void {
  const entities = ctors
    ? ctors.map((c) => registry.get(c)).filter((m): m is EntityMeta => m !== undefined)
    : [...registry.values()].filter((m) => m.declared);

  for (const meta of entities) {
    model.entity(meta.ctor, (e: EntityBuilder<object>) => {
      if (meta.table) e.toTable(meta.table);
      const keys = [...meta.properties.values()].filter((p) => p.isKey).map((p) => p.name);
      if (keys.length > 0) e.hasKey(...(keys as never[]));

      for (const p of meta.properties.values()) {
        if (p.isKey && !p.column && !p.type && p.maxLength === undefined) continue;
        const pb = e.property((x: any) => x[p.name]);
        if (p.column) pb.hasColumnName(p.column);
        if (p.type) pb.hasType(p.type);
        if (p.maxLength !== undefined) pb.hasMaxLength(p.maxLength);
        if (p.required === false) pb.isRequired(false);
        if (p.concurrency) pb.isConcurrencyToken();
      }

      for (const r of meta.relations) {
        const nav = (x: any) => x[r.name];
        if (r.kind === 'hasMany') {
          const b = e.hasMany(r.target(), nav);
          if (r.foreignKey) b.hasForeignKey(r.foreignKey);
        } else {
          const b = e.hasOne(r.target(), nav);
          if (r.foreignKey) b.hasForeignKey(r.foreignKey);
        }
      }
    });
  }
}

/** Test/reset helper. */
export function clearDecoratorRegistry(): void {
  registry.clear();
}
