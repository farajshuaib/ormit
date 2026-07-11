/**
 * Context factory (plan §3 FROZEN, §5 · S4).
 *
 * Contexts are short-lived and not concurrency-safe. The factory creates fresh
 * instances on demand and can pool them: a disposed context is reset (its
 * tracker cleared via `Symbol.asyncDispose`) and reused, which keeps identity
 * maps strictly per-instance — no cross-context leakage.
 */
import type { OrmEngine } from '../contracts/engine.js';
import type { DbContext, DbContextOptions } from './db-context.js';

export interface FactoryOptions {
  readonly engine: OrmEngine;
  /** Max idle instances to retain for reuse (default 0 = no pooling). */
  readonly poolSize?: number;
}

export interface ContextFactory<C extends DbContext> {
  /** Create (or reuse) a context. */
  create(): C;
  /** Return a context to the pool after resetting it. */
  release(context: C): Promise<void>;
  /** A scoped context that is auto-released when the callback settles. */
  scoped<R>(work: (context: C) => Promise<R>): Promise<R>;
}

type ContextCtor<C extends DbContext> = new (options: DbContextOptions) => C;

export function createContextFactory<C extends DbContext>(
  ctor: ContextCtor<C>,
  options: FactoryOptions,
): ContextFactory<C> {
  const poolSize = options.poolSize ?? 0;
  const idle: C[] = [];

  const create = (): C => idle.pop() ?? new ctor({ engine: options.engine });

  const release = async (context: C): Promise<void> => {
    await context[Symbol.asyncDispose](); // clears the tracker + caches
    if (idle.length < poolSize) idle.push(context);
  };

  const scoped = async <R>(work: (context: C) => Promise<R>): Promise<R> => {
    const context = create();
    try {
      return await work(context);
    } finally {
      await release(context);
    }
  };

  return { create, release, scoped };
}
