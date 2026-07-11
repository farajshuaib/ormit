/**
 * Timestamps plugin (plan §7): stamps `createdAt`/`updatedAt` on save via a
 * save interceptor.
 */
import type { Ctor, OrmPlugin, SavingContext } from '@ormit/core';

export interface TimestampOptions {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly entities?: readonly Ctor<object>[];
  /** Clock injection point (tests pass a fixed clock). */
  readonly now?: () => Date;
}

export function timestamps(options: TimestampOptions = {}): OrmPlugin {
  const createdAt = options.createdAt ?? 'createdAt';
  const updatedAt = options.updatedAt ?? 'updatedAt';
  const now = options.now ?? (() => new Date());
  const names = options.entities ? new Set(options.entities.map((c) => c.name)) : null;
  const applies = (name: string): boolean => (names ? names.has(name) : true);

  return {
    name: 'timestamps',
    interceptors: {
      savingChanges(ctx: SavingContext): void {
        const ts = now();
        for (const entry of ctx.entries) {
          if (!applies(entry.entityName)) continue;
          const target = entry.entity as Record<string, unknown>;
          if (entry.state === 'Added') {
            target[createdAt] = ts;
            target[updatedAt] = ts;
          } else if (entry.state === 'Modified') {
            target[updatedAt] = ts;
          }
        }
      },
    },
  };
}
