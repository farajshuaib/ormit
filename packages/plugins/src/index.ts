/**
 * `@ormit/plugins` — first-party plugins built solely on the public
 * `@ormit/core` plugin surface (the dogfood proof for the plugin API).
 */
export { softDelete, type SoftDeleteOptions } from './soft-delete.js';
export { timestamps, type TimestampOptions } from './timestamps.js';
export { multitenancy, type MultitenancyOptions } from './multitenancy.js';
