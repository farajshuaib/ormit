/** Query pipeline IR → IR passes (plan §5 · S3). */
export {
  normalize,
  injectQueryFilters,
  resolveColumns,
  resolveColumnPath,
  type NormalizeOptions,
} from './normalizer.js';
export { optimize, conjuncts } from './optimizer.js';
export { prepareSelect } from './prepare.js';
export { Lru } from './cache.js';
