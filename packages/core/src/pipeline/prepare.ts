/** Run the normalize → optimize pipeline over a select (shared by Queryable
 * terminals and the include loader's follow-up queries). */
import type { SelectExpr } from '../ir/nodes.js';
import type { ModelSnapshot } from '../metadata/snapshot.js';
import type { ValueConverterRegistry } from '../metadata/converters.js';
import type { NormalizerPass } from '../plugins/types.js';
import { normalize, type NormalizeOptions } from './normalizer.js';
import { optimize } from './optimizer.js';

export function prepareSelect(
  select: SelectExpr,
  snapshot: ModelSnapshot,
  options: NormalizeOptions = {},
  passes: readonly NormalizerPass[] = [],
  converters?: ValueConverterRegistry,
): SelectExpr {
  let prepared = normalize(select, snapshot, options, converters);
  for (const pass of passes) prepared = pass(prepared, snapshot);
  if (prepared.predicate) {
    const optimized = optimize(prepared.predicate);
    if (optimized.kind === 'lit' && optimized.value) {
      const { predicate: _drop, ...rest } = prepared;
      void _drop;
      prepared = rest;
    } else {
      prepared = { ...prepared, predicate: optimized };
    }
  }
  return prepared;
}
