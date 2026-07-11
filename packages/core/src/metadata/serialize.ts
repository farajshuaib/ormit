/**
 * Deterministic, merge-friendly serialization for `ModelSnapshotData`
 * (plan §5 · S2: "JSON-serializable with sorted keys").
 *
 * `stableStringify` recursively sorts object keys and pretty-prints with a
 * fixed 2-space indent, so two structurally equal snapshots always produce
 * byte-identical text. That is what makes the Phase 2 round-trip gate hold and
 * what keeps committed `.snapshot.json` files diffable across a team.
 */
import type { JsonValue, ModelSnapshotData } from './types.js';

/** Serialize any JSON value with recursively sorted keys and stable spacing. */
export function stableStringify(value: JsonValue, indent = 0): string {
  const pad = '  '.repeat(indent);
  const childPad = '  '.repeat(indent + 1);

  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`Cannot serialize non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => childPad + stableStringify(v, indent + 1));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (t === 'object') {
    const obj = value as { [k: string]: JsonValue };
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) return '{}';
    const entries = keys.map(
      (k) => `${childPad}${JSON.stringify(k)}: ${stableStringify(obj[k]!, indent + 1)}`,
    );
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }

  // undefined / function / symbol / bigint are not representable — fail loudly
  // rather than silently drop model information.
  throw new TypeError(`Cannot serialize value of type '${t}' in a model snapshot.`);
}

/** Serialize a finalized snapshot to its canonical, merge-friendly form. */
export function serializeSnapshot(data: ModelSnapshotData): string {
  return stableStringify(data as unknown as JsonValue) + '\n';
}

/** Parse a serialized snapshot back into data. Inverse of `serializeSnapshot`. */
export function deserializeSnapshot(text: string): ModelSnapshotData {
  return JSON.parse(text) as ModelSnapshotData;
}
