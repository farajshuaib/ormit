/**
 * Finalization (plan §5 · S2, Phase 2).
 *
 * Turns the raw builder configuration into an immutable, sorted, JSON-clean
 * `ModelSnapshotData`, filling gaps with conventions and collecting every
 * validation diagnostic in a single pass. Precedence is honored implicitly:
 * conventions are consulted only for slots the builder left `undefined`.
 */
import * as C from './conventions.js';
import { diagnostic, type Diagnostic } from './diagnostics.js';
import type {
  ModelBuilder,
  RawEntity,
  RawNavigation,
  RawProperty,
} from './builder.js';
import type {
  DeleteBehavior,
  EntitySnapshot,
  IndexSnapshot,
  JsonValue,
  ModelSnapshotData,
  NavigationSnapshot,
  PropertySnapshot,
} from './types.js';
import { SNAPSHOT_VERSION } from './types.js';

interface Working {
  readonly raw: RawEntity;
  readonly name: string;
  table: string;
  schema: string | null;
  owned: boolean;
  /** For owned-one types: the flattening column prefix (e.g. `address_`). */
  columnPrefix: string | null;
  key: string[];
  readonly known: Set<string>;
  readonly navs: NavigationSnapshot[];
  /** FK property names made nullable by an optional reference navigation. */
  readonly nullableFk: Set<string>;
}

export interface FinalizeResult {
  readonly data: ModelSnapshotData;
  readonly diagnostics: readonly Diagnostic[];
}

export function finalizeModel(builder: ModelBuilder): FinalizeResult {
  const diagnostics: Diagnostic[] = [];
  const raws = builder.rawEntities();
  const byName = new Map<string, Working>();

  // Duplicate explicit registration.
  for (const ctor of builder.duplicateCtors()) {
    diagnostics.push(
      diagnostic('OMT1203', `Entity '${ctor.name}' was registered more than once.`, {
        entity: ctor.name,
      }),
    );
  }

  // ---- Phase A: classify entities, resolve owned + table names ----
  const ownedOne = new Map<string, { owner: string; nav: string }>();
  for (const raw of raws) {
    for (const nav of raw.navigations) {
      if (nav.owned && !nav.collection) {
        ownedOne.set(nav.targetCtor.name, { owner: raw.name, nav: nav.name });
      }
    }
  }

  for (const raw of raws) {
    byName.set(raw.name, {
      raw,
      name: raw.name,
      table: '',
      schema: raw.schema ?? null,
      owned: raw.owned,
      columnPrefix: null,
      key: [],
      known: new Set(),
      navs: [],
      nullableFk: new Set(),
    });
  }

  // Non-owned + owned-many get their own table; owned-one inherits owner's.
  for (const w of byName.values()) {
    if (ownedOne.has(w.name)) continue;
    w.table = w.raw.table ?? C.tableNameFor(w.name);
    if (w.raw.table !== undefined && w.raw.table.length === 0) {
      diagnostics.push(diagnostic('OMT1219', 'toTable() was given an empty name.', { entity: w.name }));
    }
  }
  for (const [ownedName, info] of ownedOne) {
    const w = byName.get(ownedName);
    const owner = byName.get(info.owner);
    if (!w || !owner) continue;
    w.table = owner.table;
    w.schema = owner.schema;
    w.columnPrefix = C.ownedColumnName(info.nav, '');
  }

  // ---- Phase B: gather known property names from raw config ----
  for (const w of byName.values()) {
    for (const p of w.raw.properties.keys()) w.known.add(p);
    for (const k of w.raw.key ?? []) w.known.add(k);
    // FK property names are attributed to the correct side during navigation
    // resolution (Phase D). Seed columns are validated against the known set
    // (not added to it), so a seed-only column is reported as OMT1212.
    if (w.raw.discriminator?.property) w.known.add(w.raw.discriminator.property);
  }

  // ---- Phase C: resolve keys ----
  for (const w of byName.values()) {
    resolveKey(w, diagnostics);
    for (const k of w.key) w.known.add(k);
  }

  // ---- Phase D: resolve navigations + foreign keys ----
  for (const w of byName.values()) {
    for (const nav of w.raw.navigations) {
      resolveNavigation(w, nav, byName, diagnostics);
    }
  }

  // ---- Phase E: build entities ----
  const entities: EntitySnapshot[] = [];
  for (const w of byName.values()) {
    entities.push(buildEntity(w, diagnostics));
  }

  // ---- Phase F: cross-entity validation ----
  validateTablesAndDiscriminators(byName, ownedOne, diagnostics);

  entities.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { data: { version: SNAPSHOT_VERSION, entities }, diagnostics };
}

// ---------------------------------------------------------------------------

function resolveKey(w: Working, diagnostics: Diagnostic[]): void {
  if (w.raw.keyExplicit) {
    const key = [...(w.raw.key ?? [])];
    if (new Set(key).size !== key.length) {
      diagnostics.push(
        diagnostic('OMT1210', `Composite key on '${w.name}' lists a property more than once.`, {
          entity: w.name,
        }),
      );
    }
    const navNames = new Set(w.raw.navigations.map((n) => n.name));
    for (const k of key) {
      if (navNames.has(k)) {
        diagnostics.push(
          diagnostic('OMT1202', `Key property '${k}' collides with a navigation of the same name.`, {
            entity: w.name,
            member: k,
          }),
        );
      }
    }
    if (w.owned && key.length > 0) {
      diagnostics.push(
        diagnostic('OMT1216', `Owned type '${w.name}' may not declare its own key.`, {
          entity: w.name,
        }),
      );
    }
    w.key = key;
    return;
  }

  if (w.owned) {
    w.key = []; // owned types share the owner's identity
    return;
  }

  const discovered = C.discoverKey(w.name, [...w.known]);
  if (discovered === null) {
    diagnostics.push(
      diagnostic(
        'OMT1201',
        `Entity '${w.name}' has no primary key. Configure one with hasKey(), ` +
          `or add an 'id' / '${w.name.toLowerCase()}Id' property.`,
        { entity: w.name },
      ),
    );
    w.key = [];
    return;
  }
  w.key = [discovered];
}

function resolveNavigation(
  w: Working,
  nav: RawNavigation,
  byName: Map<string, Working>,
  diagnostics: Diagnostic[],
): void {
  const targetName = nav.targetCtor.name;
  const target = byName.get(targetName);
  const behavior: DeleteBehavior = nav.deleteBehavior ?? C.defaultDeleteBehavior(nav.required === false);

  // Owned navigations carry no independent foreign key. ownsOne is flattened
  // into the owner's table; ownsMany gets a synthesized FK back to the owner.
  if (nav.owned) {
    if (nav.collection && target) {
      const fkName = C.camelCase(w.name) + C.capitalize(w.key[0] ?? 'id');
      target.known.add(fkName);
      w.navs.push(navSnapshot(nav, targetName, true, [fkName], w.key, behavior));
    } else {
      w.navs.push(navSnapshot(nav, targetName, false, [], target?.key ?? [], behavior));
    }
    return;
  }

  // Many-to-many.
  if (nav.collection && nav.inverseCollection === true) {
    if (nav.joinCtor && !byName.has(nav.joinCtor.name)) {
      diagnostics.push(
        diagnostic(
          'OMT1220',
          `Join entity '${nav.joinCtor.name}' for the many-to-many '${w.name}.${nav.name}' ` +
            `is not registered in the model.`,
          { entity: w.name, member: nav.name },
        ),
      );
    }
    w.navs.push(navSnapshot(nav, targetName, true, [], target?.key ?? [], behavior));
    if (target && nav.inverseName) {
      target.navs.push({
        name: nav.inverseName,
        target: w.name,
        collection: true,
        foreignKey: [],
        principalKey: w.key,
        inverse: nav.name,
        deleteBehavior: behavior,
        owned: false,
        joinEntity: nav.joinCtor?.name ?? null,
      });
    }
    return;
  }

  // Reference nav (to-one): FK lives on THIS entity; principal is the target.
  if (!nav.collection) {
    const principalKey = target?.key ?? [];
    const fk = resolveFk(nav, nav.name, w, targetName, principalKey, diagnostics);
    for (const name of fk) {
      w.known.add(name);
      if (nav.required === false) w.nullableFk.add(name);
    }
    w.navs.push(navSnapshot(nav, targetName, false, fk, principalKey, behavior));
    if (target && nav.inverseName) {
      target.navs.push({
        name: nav.inverseName,
        target: w.name,
        collection: nav.inverseCollection ?? true,
        foreignKey: fk,
        principalKey,
        inverse: nav.name,
        deleteBehavior: behavior,
        owned: false,
        joinEntity: null,
      });
    }
    return;
  }

  // Collection nav (one-to-many): FK lives on the TARGET (dependent side).
  // Convention names the FK after the dependent's reference navigation
  // (its inverse, e.g. `author`) rather than this collection's name.
  const principalKey = w.key;
  const fkNavName = nav.inverseName ?? C.camelCase(w.name);
  const fk = target ? resolveFk(nav, fkNavName, target, w.name, principalKey, diagnostics) : [];
  if (target) for (const name of fk) target.known.add(name);
  w.navs.push(navSnapshot(nav, targetName, true, fk, principalKey, behavior));
  if (target && nav.inverseName) {
    target.navs.push({
      name: nav.inverseName,
      target: w.name,
      collection: false,
      foreignKey: fk,
      principalKey,
      inverse: nav.name,
      deleteBehavior: behavior,
      owned: false,
      joinEntity: null,
    });
  }
}

/**
 * Resolve FK property names on `dependent`. An explicit `hasForeignKey` wins;
 * otherwise convention prefers an existing candidate property and, failing
 * that, synthesizes a shadow FK (EF behavior). Only a principal with no key is
 * unresolvable.
 */
function resolveFk(
  nav: RawNavigation,
  fkNavName: string,
  dependent: Working,
  principalName: string,
  principalKey: readonly string[],
  diagnostics: Diagnostic[],
): readonly string[] {
  if (nav.foreignKey && nav.foreignKey.length > 0) {
    if (principalKey.length > 0 && nav.foreignKey.length !== principalKey.length) {
      diagnostics.push(
        diagnostic(
          'OMT1207',
          `Foreign key '${nav.foreignKey.join(', ')}' has ${nav.foreignKey.length} ` +
            `column(s) but the principal key of '${principalName}' has ${principalKey.length}.`,
          { entity: dependent.name, member: nav.name },
        ),
      );
    }
    return nav.foreignKey;
  }
  const pk = principalKey[0];
  if (pk === undefined) {
    diagnostics.push(
      diagnostic(
        'OMT1208',
        `Cannot resolve a foreign key for '${dependent.name}.${nav.name}': ` +
          `principal '${principalName}' has no primary key.`,
        { entity: dependent.name, member: nav.name },
      ),
    );
    return [];
  }
  const existing = C.discoverForeignKey(fkNavName, principalName, pk, [...dependent.known]);
  // Fall back to the first convention candidate as a synthesized shadow FK.
  const candidates = C.foreignKeyCandidates(fkNavName, principalName, pk);
  return [existing ?? candidates[0]!];
}

function navSnapshot(
  nav: RawNavigation,
  targetName: string,
  collection: boolean,
  fk: readonly string[],
  principalKey: readonly string[],
  behavior: DeleteBehavior,
): NavigationSnapshot {
  return {
    name: nav.name,
    target: targetName,
    collection,
    foreignKey: fk,
    principalKey,
    inverse: nav.inverseName ?? null,
    deleteBehavior: behavior,
    owned: nav.owned,
    joinEntity: nav.joinCtor?.name ?? null,
  };
}

function buildEntity(w: Working, diagnostics: Diagnostic[]): EntitySnapshot {
  const keySet = new Set(w.key);
  const props: PropertySnapshot[] = [];
  const columns = new Map<string, string[]>();

  for (const name of w.known) {
    const raw = w.raw.properties.get(name);
    const prop = buildProperty(w, name, raw, keySet.has(name), w.nullableFk.has(name), diagnostics);
    props.push(prop);
    const owners = columns.get(prop.column) ?? [];
    owners.push(name);
    columns.set(prop.column, owners);
  }

  for (const [column, owners] of columns) {
    if (owners.length > 1) {
      diagnostics.push(
        diagnostic(
          'OMT1205',
          `Properties ${owners.join(', ')} on '${w.name}' all map to column '${column}'.`,
          { entity: w.name },
        ),
      );
    }
  }

  for (const nav of w.navs) {
    if (w.raw.properties.has(nav.name)) {
      diagnostics.push(
        diagnostic(
          'OMT1221',
          `Navigation '${w.name}.${nav.name}' collides with a scalar property of the same name.`,
          { entity: w.name, member: nav.name },
        ),
      );
    }
  }

  const indexes = buildIndexes(w, diagnostics);
  const seedData = buildSeed(w, keySet, diagnostics);
  const discriminator = buildDiscriminator(w, diagnostics);

  props.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  w.navs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // The IR is structurally JSON (its only escape hatch, ConstantExpr.value, is
  // always a JSON literal in a query filter). Bridge the nominal type here.
  const queryFilter: JsonValue =
    w.raw.queryFilter === undefined ? null : (w.raw.queryFilter as unknown as JsonValue);

  return {
    name: w.name,
    table: w.table,
    schema: w.schema,
    key: [...w.key],
    properties: props,
    navigations: w.navs,
    indexes,
    queryFilter,
    seedData,
    discriminator,
    owned: w.owned,
  };
}

function buildProperty(
  w: Working,
  name: string,
  raw: RawProperty | undefined,
  isKey: boolean,
  fkNullable: boolean,
  diagnostics: Diagnostic[],
): PropertySnapshot {
  const baseColumn = raw?.column ?? C.columnNameFor(name);
  if (raw?.column !== undefined && raw.column.length === 0) {
    diagnostics.push(
      diagnostic('OMT1217', `hasColumnName() on '${w.name}.${name}' was given an empty name.`, {
        entity: w.name,
        member: name,
      }),
    );
  }
  const column = w.columnPrefix ? w.columnPrefix + baseColumn : baseColumn;

  if (raw?.maxLength !== undefined && (!Number.isInteger(raw.maxLength) || raw.maxLength <= 0)) {
    diagnostics.push(
      diagnostic('OMT1206', `hasMaxLength() on '${w.name}.${name}' must be a positive integer.`, {
        entity: w.name,
        member: name,
      }),
    );
  }
  if (raw?.conversion !== undefined && raw.conversion.length === 0) {
    diagnostics.push(
      diagnostic('OMT1215', `hasConversion() on '${w.name}.${name}' requires a converter name.`, {
        entity: w.name,
        member: name,
      }),
    );
  }
  if (raw?.concurrencyToken && isKey) {
    diagnostics.push(
      diagnostic('OMT1218', `Key property '${w.name}.${name}' cannot be a concurrency token.`, {
        entity: w.name,
        member: name,
      }),
    );
  }
  if (raw?.hasDefault && raw.defaultValueSql !== undefined) {
    diagnostics.push(
      diagnostic(
        'OMT1223',
        `Property '${w.name}.${name}' sets both hasDefault() and hasDefaultSql().`,
        { entity: w.name, member: name },
      ),
    );
  }

  const nullable = raw?.nullable ?? (isKey ? false : fkNullable ? true : false);
  const valueGenerated =
    raw?.valueGenerated ?? conventionValueGenerated(isKey, w.key.length, inferType(raw));

  return {
    name,
    column,
    type: inferType(raw),
    nullable: isKey ? false : nullable,
    maxLength: raw?.maxLength ?? null,
    defaultValue: raw?.hasDefault ? (raw.defaultValue ?? null) : null,
    defaultValueSql: raw?.defaultValueSql ?? null,
    concurrencyToken: raw?.concurrencyToken ?? false,
    valueGenerated,
    conversion: raw?.conversion ?? null,
    comment: raw?.comment ?? null,
  };
}

function inferType(raw: RawProperty | undefined): PropertySnapshot['type'] {
  return C.inferClrType({
    explicit: raw?.type,
    maxLength: raw?.maxLength,
    defaultValue: raw?.hasDefault ? raw.defaultValue : undefined,
  });
}

/** Sole numeric/unknown keys auto-increment by convention; composite keys don't. */
function conventionValueGenerated(
  isKey: boolean,
  keyArity: number,
  type: PropertySnapshot['type'],
): PropertySnapshot['valueGenerated'] {
  if (!isKey || keyArity !== 1) return 'never';
  if (type === 'number' || type === 'bigint' || type === 'unknown') return 'onAdd';
  return 'never';
}

function buildIndexes(w: Working, diagnostics: Diagnostic[]): IndexSnapshot[] {
  const indexes: IndexSnapshot[] = [];
  for (const idx of w.raw.indexes) {
    if (idx.properties.length === 0) {
      diagnostics.push(
        diagnostic('OMT1214', `An index on '${w.name}' declares no properties.`, { entity: w.name }),
      );
      continue;
    }
    for (const p of idx.properties) {
      if (!w.known.has(p)) {
        diagnostics.push(
          diagnostic('OMT1213', `Index on '${w.name}' references unknown property '${p}'.`, {
            entity: w.name,
            member: p,
          }),
        );
      }
    }
    indexes.push({
      name: idx.name ?? defaultIndexName(w.table, idx.properties),
      properties: [...idx.properties],
      unique: idx.unique,
    });
  }
  indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return indexes;
}

function defaultIndexName(table: string, properties: readonly string[]): string {
  return `IX_${table}_${properties.join('_')}`;
}

function buildSeed(w: Working, keySet: Set<string>, diagnostics: Diagnostic[]): JsonValue[] {
  const seed: JsonValue[] = [];
  for (const row of w.raw.seedData) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      diagnostics.push(
        diagnostic('OMT1212', `A seed row on '${w.name}' is not an object.`, { entity: w.name }),
      );
      continue;
    }
    const obj = row as { [k: string]: JsonValue };
    for (const key of Object.keys(obj)) {
      if (!w.known.has(key)) {
        diagnostics.push(
          diagnostic('OMT1212', `Seed row on '${w.name}' references unknown property '${key}'.`, {
            entity: w.name,
            member: key,
          }),
        );
      }
    }
    for (const k of keySet) {
      if (!(k in obj)) {
        diagnostics.push(
          diagnostic('OMT1211', `Seed row on '${w.name}' is missing key property '${k}'.`, {
            entity: w.name,
            member: k,
          }),
        );
      }
    }
    seed.push(obj);
  }
  return seed;
}

function buildDiscriminator(
  w: Working,
  diagnostics: Diagnostic[],
): EntitySnapshot['discriminator'] {
  const disc = w.raw.discriminator;
  if (!disc) return null;
  if (disc.value === undefined) {
    diagnostics.push(
      diagnostic('OMT1222', `Discriminator on '${w.name}' was declared without a value.`, {
        entity: w.name,
      }),
    );
    return { column: disc.column, property: disc.property ?? null, value: '' };
  }
  return { column: disc.column, property: disc.property ?? null, value: disc.value };
}

function validateTablesAndDiscriminators(
  byName: Map<string, Working>,
  ownedOne: Map<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  const byTable = new Map<string, Working[]>();
  for (const w of byName.values()) {
    if (ownedOne.has(w.name)) continue; // shares owner's table by design
    const list = byTable.get(w.table) ?? [];
    list.push(w);
    byTable.set(w.table, list);
  }
  for (const [table, group] of byTable) {
    if (group.length < 2) continue;
    const allHaveDiscriminator = group.every((g) => g.raw.discriminator?.value);
    if (allHaveDiscriminator) {
      const seen = new Map<string, string>();
      for (const g of group) {
        const value = g.raw.discriminator!.value!;
        const prev = seen.get(value);
        if (prev !== undefined) {
          diagnostics.push(
            diagnostic(
              'OMT1209',
              `Discriminator value '${value}' on table '${table}' is used by both ` +
                `'${prev}' and '${g.name}'.`,
              { entity: g.name },
            ),
          );
        }
        seen.set(value, g.name);
      }
    } else {
      for (const g of group) {
        diagnostics.push(
          diagnostic(
            'OMT1204',
            `Entities ${group.map((x) => x.name).join(', ')} all map to table '${table}'.`,
            { entity: g.name },
          ),
        );
        break;
      }
    }
  }
}
