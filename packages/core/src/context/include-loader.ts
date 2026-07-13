/**
 * Eager-loading via split queries (plan §5 · S3/S8, ADR-003).
 *
 * Rather than a cartesian JOIN, each Include runs a follow-up `WHERE fk IN (…)`
 * query and stitches the results into the roots' navigation properties. This
 * avoids row explosion and keeps materialization per-entity. ThenIncludes
 * recurse over the freshly loaded targets.
 */
import type { BoolExprNode, IncludeNode, SelectExpr } from '../ir/nodes.js';
import type { Row } from '../contracts/engine.js';
import type { ModelSnapshot } from '../metadata/snapshot.js';
import type { EntitySnapshot } from '../metadata/types.js';
import { entityConverters, type ValueConverterRegistry } from '../metadata/converters.js';

export interface LoadInfo {
  readonly entity: string;
  readonly navigation: string;
  readonly rootCount: number;
  readonly keyCount: number;
}

export interface ContextServices {
  readonly snapshot: ModelSnapshot;
  runSelect(select: SelectExpr): Promise<readonly Row[]>;
  /** Observability hook (drives the N+1 detector in diagnostics mode). */
  onLoad?(info: LoadInfo): void;
  /** Value converters applied when materializing loaded rows. */
  readonly converters?: ValueConverterRegistry;
}

export async function loadIncludes(
  roots: readonly object[],
  includes: readonly IncludeNode[],
  services: ContextServices,
): Promise<void> {
  for (const include of includes) await loadOne(roots, include, services);
}

async function loadOne(
  roots: readonly object[],
  include: IncludeNode,
  services: ContextServices,
): Promise<void> {
  if (roots.length === 0) return;
  const targetMeta = services.snapshot.entity(include.target);
  if (!targetMeta) return;

  const [linkProp, matchProp] = include.collection
    ? [include.principalKey[0], include.foreignKey[0]] // group children by their FK
    : [include.foreignKey[0], include.principalKey[0]]; // look up target by its key
  if (!linkProp || !matchProp) return;

  const linkValues = unique(get(roots, linkProp));
  const rows = linkValues.length
    ? await services.runSelect(inSelect(include, matchProp, linkValues))
    : [];
  const targets = rows.map((r) => materializePlain(r, targetMeta, services.converters));

  services.onLoad?.({
    entity: include.target,
    navigation: include.navigation,
    rootCount: roots.length,
    keyCount: linkValues.length,
  });

  if (include.collection) {
    const groups = new Map<unknown, object[]>();
    for (const child of targets) {
      const key = (child as Record<string, unknown>)[matchProp];
      const bucket = groups.get(key);
      if (bucket) bucket.push(child);
      else groups.set(key, [child]);
    }
    for (const root of roots) {
      (root as Record<string, unknown>)[include.navigation] =
        groups.get((root as Record<string, unknown>)[linkProp]) ?? [];
    }
  } else {
    const byKey = new Map<unknown, object>();
    for (const target of targets) byKey.set((target as Record<string, unknown>)[matchProp], target);
    for (const root of roots) {
      (root as Record<string, unknown>)[include.navigation] =
        byKey.get((root as Record<string, unknown>)[linkProp]) ?? null;
    }
  }

  if (include.children.length > 0) await loadIncludes(targets, include.children, services);
}

function inSelect(include: IncludeNode, keyProp: string, values: readonly unknown[]): SelectExpr {
  const inNode: BoolExprNode = { kind: 'in', target: { kind: 'column', path: [keyProp] }, values: [...values] };
  const predicate: BoolExprNode = include.filter
    ? { kind: 'logical', op: 'and', operands: [include.filter, inNode] }
    : inNode;
  return { kind: 'select', entity: include.target, predicate, orderings: [] };
}

function materializePlain(
  row: Row,
  entity: EntitySnapshot,
  registry: ValueConverterRegistry | undefined,
): object {
  const reverse = new Map<string, string>();
  for (const p of entity.properties) if (p.column !== p.name) reverse.set(p.column, p.name);
  const convs = entityConverters(entity.properties, registry);
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const prop = reverse.get(column) ?? column;
    const converter = value === null || value === undefined ? undefined : convs.get(prop);
    out[prop] = converter ? converter.fromProvider(value) : value;
  }
  return out;
}

function get(roots: readonly object[], prop: string): unknown[] {
  return roots.map((r) => (r as Record<string, unknown>)[prop]);
}

function unique(values: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
