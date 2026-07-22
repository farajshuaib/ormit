import type { ModelBuilder } from '@ormit/core';

/** A minimal model function — the loader tests only care that this loaded
 * and is callable, not that it declares real entities. */
export function defineModel(_m: ModelBuilder): void {
  // intentionally empty
}
