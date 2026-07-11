/**
 * Soft-delete plugin (plan §7). Dogfood proof: implemented entirely on the
 * public `@ormit/core` plugin surface — a global query filter plus a save
 * interceptor that rewrites deletes into an update of the flag column.
 */
import type { Ctor, ModelBuilder, OrmPlugin, SavingContext } from '@ormit/core';

export interface SoftDeleteOptions {
  /** Boolean flag column (default `isDeleted`). */
  readonly column?: string;
  /** Entities to apply to; defaults to every declared entity. */
  readonly entities?: readonly Ctor<object>[];
}

export function softDelete(options: SoftDeleteOptions = {}): OrmPlugin {
  const column = options.column ?? 'isDeleted';
  const names = new Set<string>();

  return {
    name: 'soft-delete',
    configureModel(model: ModelBuilder): void {
      const ctors = options.entities ?? model.declaredCtors();
      for (const ctor of ctors) {
        names.add(ctor.name);
        // Every read excludes soft-deleted rows (opt out via ignoreQueryFilters).
        model.configure(ctor, (e) => {
          e.hasQueryFilter((x) => (x as Record<string, { eq(v: boolean): never }>)[column]!.eq(false));
        });
      }
    },
    interceptors: {
      savingChanges(ctx: SavingContext): void {
        for (const entry of ctx.entries) {
          if (entry.state === 'Deleted' && names.has(entry.entityName)) {
            (entry.entity as Record<string, unknown>)[column] = true;
            entry.state = 'Modified'; // becomes an UPDATE isDeleted = true
          }
        }
      },
    },
  };
}
