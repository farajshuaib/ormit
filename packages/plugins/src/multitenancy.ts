/**
 * Multitenancy plugin — discriminator-column mode (plan §7).
 *
 * A normalizer pass scopes every read to the current tenant; a save interceptor
 * stamps the tenant column on inserts. The tenant id is resolved per-operation
 * from a provider (typically backed by AsyncLocalStorage), so one context can
 * serve requests for different tenants.
 */
import type {
  Ctor,
  NormalizerPass,
  OrmPlugin,
  SavingContext,
  SelectExpr,
} from '@ormit/core';

export interface MultitenancyOptions {
  /** Resolves the current tenant id (e.g. from ALS). */
  readonly tenant: () => unknown;
  /** Tenant discriminator column (default `tenantId`). */
  readonly column?: string;
  readonly entities?: readonly Ctor<object>[];
}

export function multitenancy(options: MultitenancyOptions): OrmPlugin {
  const column = options.column ?? 'tenantId';
  const names = options.entities ? new Set(options.entities.map((c) => c.name)) : null;
  const applies = (name: string): boolean => (names ? names.has(name) : true);

  const pass: NormalizerPass = (select: SelectExpr): SelectExpr => {
    if (!applies(select.entity)) return select;
    const filter = {
      kind: 'binary' as const,
      op: 'eq' as const,
      left: { kind: 'column' as const, path: [column] },
      right: { kind: 'constant' as const, value: options.tenant() },
    };
    const predicate = select.predicate
      ? { kind: 'logical' as const, op: 'and' as const, operands: [filter, select.predicate] }
      : filter;
    return { ...select, predicate };
  };

  return {
    name: 'multitenancy',
    normalizerPasses: [pass],
    interceptors: {
      savingChanges(ctx: SavingContext): void {
        const tenant = options.tenant();
        for (const entry of ctx.entries) {
          if (entry.state === 'Added' && applies(entry.entityName)) {
            (entry.entity as Record<string, unknown>)[column] = tenant;
          }
        }
      },
    },
  };
}
