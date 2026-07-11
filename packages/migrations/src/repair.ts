/**
 * Snapshot repair (plan §8, risk R5): teams occasionally hit a merge conflict
 * in the committed `.snapshot.json`. Because the snapshot is byte-canonical
 * (sorted keys) and the *model* is the source of truth, repair re-derives the
 * canonical snapshot from the current model — resolving the conflict
 * deterministically — and reports whether the committed text had drifted.
 */
import { deserializeSnapshot, serializeSnapshot, type ModelSnapshot } from '@ormit/core';

export interface RepairResult {
  readonly snapshot: string;
  readonly changed: boolean;
}

/** Regenerate the canonical snapshot from the model; compare to `committed`. */
export function repairSnapshot(model: ModelSnapshot, committed?: string): RepairResult {
  const canonical = model.toJSON();
  if (committed === undefined) return { snapshot: canonical, changed: true };

  // Normalize the committed text (drop conflict markers, re-canonicalize) so a
  // pure formatting/order difference doesn't count as drift.
  let normalized: string | null = null;
  try {
    normalized = serializeSnapshot(deserializeSnapshot(stripConflictMarkers(committed)));
  } catch {
    normalized = null; // unparseable (real conflict) ⇒ treat as changed
  }
  return { snapshot: canonical, changed: normalized !== canonical };
}

/** Keep the "ours" side of any git conflict markers, drop the rest. */
function stripConflictMarkers(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) continue;
    if (line.startsWith('=======')) {
      skipping = true;
      continue;
    }
    if (line.startsWith('>>>>>>>')) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}
