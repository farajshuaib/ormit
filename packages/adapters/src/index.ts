/**
 * `@ormit/adapters` (plan §2) — thin DI/lifecycle glue for web frameworks.
 *
 * A DbContext is short-lived and per-request (plan §5). These adapters create a
 * pooled context at the start of a request, expose it, and dispose it when the
 * request ends. They depend only on `@ormit/core`; the frameworks are typed
 * structurally so no framework is pulled in as a dependency.
 */
import { createContextFactory, type ContextFactory, type DbContext } from '@ormit/core';
import type { FactoryOptions } from '@ormit/core';

export type ContextCtor<C extends DbContext> = new (options: { engine: FactoryOptions['engine'] }) => C;

/** Build a pooled factory once at app startup. */
export function createOrmitFactory<C extends DbContext>(
  ctor: ContextCtor<C>,
  options: FactoryOptions,
): ContextFactory<C> {
  return createContextFactory(ctor, options);
}

/** A per-request scope: a context plus its disposer. */
export interface OrmitScope<C extends DbContext> {
  readonly db: C;
  dispose(): Promise<void>;
}

export function openScope<C extends DbContext>(factory: ContextFactory<C>): OrmitScope<C> {
  const db = factory.create();
  let disposed = false;
  return {
    db,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await factory.release(db);
    },
  };
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

interface ExpressResLike {
  once(event: string, listener: () => void): unknown;
}
type ExpressNext = (err?: unknown) => void;

/** Express middleware: attaches `req[property]` and disposes when the response
 * finishes or the connection closes. */
export function ormitExpress<C extends DbContext>(
  factory: ContextFactory<C>,
  property = 'db',
): (req: Record<string, unknown>, res: ExpressResLike, next: ExpressNext) => void {
  return (req, res, next) => {
    const scope = openScope(factory);
    req[property] = scope.db;
    const release = (): void => void scope.dispose();
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------

interface FastifyLike {
  decorateRequest(name: string, value: unknown): unknown;
  addHook(name: 'onRequest' | 'onResponse', handler: FastifyHook): unknown;
}
type FastifyHook = (request: Record<string, unknown>, reply: unknown) => Promise<void> | void;

export interface FastifyPluginOptions {
  property?: string;
}

/** A Fastify plugin `(fastify, options, done)`. Sets `request[property]` on
 * `onRequest` and disposes it on `onResponse`. */
export function ormitFastify<C extends DbContext>(factory: ContextFactory<C>) {
  return function plugin(
    fastify: FastifyLike,
    options: FastifyPluginOptions,
    done: () => void,
  ): void {
    const property = options.property ?? 'db';
    const scopes = new WeakMap<object, OrmitScope<C>>();
    fastify.decorateRequest(property, null);
    fastify.addHook('onRequest', (request) => {
      const scope = openScope(factory);
      scopes.set(request, scope);
      request[property] = scope.db;
    });
    fastify.addHook('onResponse', async (request) => {
      await scopes.get(request)?.dispose();
    });
    done();
  };
}

// ---------------------------------------------------------------------------
// NestJS
// ---------------------------------------------------------------------------

export interface NestProvider {
  provide: unknown;
  useFactory: (...args: unknown[]) => unknown;
  inject?: unknown[];
  scope?: 'DEFAULT' | 'REQUEST' | 'TRANSIENT';
}

export const ORMIT_FACTORY = Symbol('ORMIT_FACTORY');

/** NestJS providers: a singleton factory plus a REQUEST-scoped context bound to
 * the entity ctor, ready to spread into a module's `providers`. */
export function ormitNestProviders<C extends DbContext>(
  ctor: ContextCtor<C>,
  options: FactoryOptions,
): NestProvider[] {
  return [
    {
      provide: ORMIT_FACTORY,
      useFactory: () => createContextFactory(ctor, options),
    },
    {
      provide: ctor,
      scope: 'REQUEST',
      inject: [ORMIT_FACTORY],
      useFactory: (factory: unknown) => (factory as ContextFactory<C>).create(),
    },
  ];
}
