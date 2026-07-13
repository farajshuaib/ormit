/**
 * Save planning (plan §5 · S4): turn tracker state into an ordered list of
 * write operations. Inserts run parent→child and deletes child→parent (topo
 * order over the FK graph); updates carry only changed columns; key and
 * concurrency-token predicates target exactly the intended row.
 *
 * Planning is pure and independently testable; execution (transaction,
 * key write-back, concurrency check) lives in DbContext.
 */
import type { BoolExprNode, WriteOp } from '../ir/nodes.js';
import type { ModelSnapshot } from '../metadata/snapshot.js';
import type { EntitySnapshot } from '../metadata/types.js';
import {
  entityConverters,
  type ValueConverter,
  type ValueConverterRegistry,
} from '../metadata/converters.js';
import type { ChangeTracker, EntityEntry } from './tracker.js';

/** Apply a property's converter on the way to the database (null passes through). */
function toDb(value: unknown, prop: string, converters: Map<string, ValueConverter>): unknown {
  if (value === null || value === undefined || converters.size === 0) return value;
  const converter = converters.get(prop);
  return converter ? converter.toProvider(value) : value;
}

export interface SaveStep {
  readonly op: WriteOp;
  readonly entry: EntityEntry;
  /** Physical column → JS property, for writing generated values back. */
  readonly reverseColumns: ReadonlyMap<string, string>;
  /** Whether a zero-row result signals a concurrency conflict. */
  readonly concurrency: boolean;
}

export function planSave(
  tracker: ChangeTracker,
  model: ModelSnapshot,
  converters?: ValueConverterRegistry,
): SaveStep[] {
  const order = topoSort(model);
  const rank = new Map(order.map((name, i) => [name, i] as const));
  const rankOf = (name: string) => rank.get(name) ?? order.length;

  const inserts = tracker
    .entriesInState('Added')
    .sort((a, b) => rankOf(a.entityName) - rankOf(b.entityName));
  const updates = tracker.entriesInState('Modified');
  const deletes = tracker
    .entriesInState('Deleted')
    .sort((a, b) => rankOf(b.entityName) - rankOf(a.entityName)); // children first

  const steps: SaveStep[] = [];
  for (const entry of inserts) steps.push(buildInsert(entry, model, converters));
  for (const entry of updates) steps.push(buildUpdate(entry, model, converters));
  for (const entry of deletes) {
    // Cascade to dependents first (child rows before the principal row).
    for (const step of cascadeFor(entry, model, converters)) steps.push(step);
    steps.push(buildDelete(entry, model, converters));
  }
  return steps;
}

/**
 * Dependent-side effects of deleting a principal: `cascade` bulk-deletes child
 * rows, `setNull` clears their FK. `restrict`/`noAction` defer to the database.
 */
function cascadeFor(
  entry: EntityEntry,
  model: ModelSnapshot,
  registry: ValueConverterRegistry | undefined,
): SaveStep[] {
  const entity = meta(model, entry.entityName);
  if (!entity) return [];
  const principalKey = keyProps(entity)[0];
  if (!principalKey) return [];
  const convs = entityConverters(entity.properties, registry);
  const keyValue = toDb(entry.currentValues()[principalKey], principalKey, convs);
  const steps: SaveStep[] = [];

  for (const nav of entity.navigations) {
    if (!nav.collection || nav.owned) continue;
    if (nav.deleteBehavior !== 'cascade' && nav.deleteBehavior !== 'setNull') continue;
    const child = meta(model, nav.target);
    const fkProp = nav.foreignKey[0];
    if (!fkProp) continue;
    const fkColumn = col(columnMap(child), fkProp);
    const predicate = eqAll([[fkColumn, keyValue]]);
    const op: WriteOp =
      nav.deleteBehavior === 'cascade'
        ? { kind: 'delete', entity: nav.target, predicate }
        : { kind: 'update', entity: nav.target, values: { [fkColumn]: null }, predicate };
    steps.push({ op, entry, reverseColumns: new Map(), concurrency: false });
  }
  return steps;
}

// ---------------------------------------------------------------------------

function meta(model: ModelSnapshot, name: string): EntitySnapshot | null {
  return model.entity(name);
}

/** property → physical column for an entity (identity for unmapped props). */
function columnMap(entity: EntitySnapshot | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of entity?.properties ?? []) map.set(p.name, p.column);
  return map;
}

function reverseColumnMap(entity: EntitySnapshot | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of entity?.properties ?? []) if (p.column !== p.name) map.set(p.column, p.name);
  return map;
}

function keyProps(entity: EntitySnapshot | null): readonly string[] {
  return entity && entity.key.length > 0 ? entity.key : ['id'];
}

function concurrencyProp(entity: EntitySnapshot | null): string | null {
  return entity?.properties.find((p) => p.concurrencyToken)?.name ?? null;
}

function col(map: Map<string, string>, prop: string): string {
  return map.get(prop) ?? prop;
}

function eqAll(pairs: readonly (readonly [string, unknown])[]): BoolExprNode {
  const nodes: BoolExprNode[] = pairs.map(([column, value]) => ({
    kind: 'binary',
    op: 'eq',
    left: { kind: 'column', path: [column] },
    right: { kind: 'constant', value },
  }));
  return nodes.length === 1 ? nodes[0]! : { kind: 'logical', op: 'and', operands: nodes };
}

function buildInsert(
  entry: EntityEntry,
  model: ModelSnapshot,
  registry: ValueConverterRegistry | undefined,
): SaveStep {
  const entity = meta(model, entry.entityName);
  const cols = columnMap(entity);
  const convs = entityConverters(entity?.properties ?? [], registry);
  const values: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(entry.currentValues())) {
    values[col(cols, prop)] = toDb(value, prop, convs);
  }
  return {
    op: { kind: 'insert', entity: entry.entityName, values },
    entry,
    reverseColumns: reverseColumnMap(entity),
    concurrency: false,
  };
}

function buildUpdate(
  entry: EntityEntry,
  model: ModelSnapshot,
  registry: ValueConverterRegistry | undefined,
): SaveStep {
  const entity = meta(model, entry.entityName);
  const cols = columnMap(entity);
  const convs = entityConverters(entity?.properties ?? [], registry);
  const keys = new Set(keyProps(entity));
  const current = entry.currentValues();

  const values: Record<string, unknown> = {};
  for (const prop of entry.modifiedProperties()) {
    if (!keys.has(prop)) values[col(cols, prop)] = toDb(current[prop], prop, convs);
  }
  return {
    op: {
      kind: 'update',
      entity: entry.entityName,
      values,
      predicate: rowPredicate(entry, model, registry),
    },
    entry,
    reverseColumns: reverseColumnMap(entity),
    // A tracked update must hit its row; zero rows ⇒ it vanished/changed.
    concurrency: true,
  };
}

function buildDelete(
  entry: EntityEntry,
  model: ModelSnapshot,
  registry: ValueConverterRegistry | undefined,
): SaveStep {
  const entity = meta(model, entry.entityName);
  return {
    op: {
      kind: 'delete',
      entity: entry.entityName,
      predicate: rowPredicate(entry, model, registry),
    },
    entry,
    reverseColumns: reverseColumnMap(entity),
    concurrency: true,
  };
}

/** key columns = current values, AND concurrency token = its ORIGINAL value. */
function rowPredicate(
  entry: EntityEntry,
  model: ModelSnapshot,
  registry: ValueConverterRegistry | undefined,
): BoolExprNode {
  const entity = meta(model, entry.entityName);
  const cols = columnMap(entity);
  const convs = entityConverters(entity?.properties ?? [], registry);
  const current = entry.currentValues();
  const pairs: (readonly [string, unknown])[] = keyProps(entity).map((k) => [
    col(cols, k),
    toDb(current[k], k, convs),
  ]);
  const token = concurrencyProp(entity);
  if (token) pairs.push([col(cols, token), toDb(entry.snapshot[token], token, convs)]);
  return eqAll(pairs);
}

/**
 * Topological order of entity names, principals before dependents. A reference
 * navigation puts the FK on the declaring entity (it depends on the target); a
 * collection navigation puts the FK on the target (the target depends here).
 */
export function topoSort(model: ModelSnapshot): string[] {
  const names = model.entities.map((e) => e.name);
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const entity of model.entities) {
    for (const nav of entity.navigations) {
      if (nav.owned) continue;
      if (!nav.collection) deps.get(entity.name)?.add(nav.target); // dependent → principal
      else deps.get(nav.target)?.add(entity.name);
    }
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name) || inStack.has(name)) return; // ignore cycles/back-edges
    inStack.add(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    inStack.delete(name);
    visited.add(name);
    order.push(name);
  };
  for (const name of names) visit(name);
  return order; // dependencies pushed before dependents
}
