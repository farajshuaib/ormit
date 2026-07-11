import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { InMemoryEngine } from '@ormit/testing';
import {
  createOrmitFactory,
  ormitExpress,
  ormitFastify,
  ormitNestProviders,
  openScope,
  ORMIT_FACTORY,
  type NestProvider,
} from '@ormit/adapters';

class User {
  id!: number;
  name!: string;
}
class AppDb extends DbContext {
  users = this.set(User);
  constructor(opts: DbContextOptions) {
    super(opts);
  }
  protected onModelCreating(model: ModelBuilder): void {
    model.entity(User, (e) => e.toTable('users').hasKey('id'));
  }
}

function factory(pool = 2) {
  return createOrmitFactory(AppDb, { engine: new InMemoryEngine(), poolSize: pool });
}

describe('openScope', () => {
  it('creates a context and disposes it once', async () => {
    const scope = openScope(factory());
    expect(scope.db).toBeInstanceOf(AppDb);
    await scope.dispose();
    await scope.dispose(); // idempotent — no throw
  });
});

describe('Express middleware', () => {
  it('attaches req.db and releases on response finish', async () => {
    const mw = ormitExpress(factory());
    const req: Record<string, unknown> = {};
    const res = new EventEmitter();
    let nextCalled = false;

    mw(req, { once: res.once.bind(res) }, () => (nextCalled = true));
    expect(nextCalled).toBe(true);
    expect(req['db']).toBeInstanceOf(AppDb);

    // Simulate the response completing → the context is disposed.
    const db = req['db'] as AppDb;
    db.users.add(Object.assign(new User(), { name: 'A' })); // tracked
    res.emit('finish');
    await Promise.resolve();
    // After disposal a fresh save has nothing pending (tracker cleared).
    expect(await db.saveChanges()).toBe(0);
  });

  it('supports a custom property name', () => {
    const mw = ormitExpress(factory(), 'orm');
    const req: Record<string, unknown> = {};
    mw(req, { once: () => undefined }, () => undefined);
    expect(req['orm']).toBeInstanceOf(AppDb);
  });
});

describe('Fastify plugin', () => {
  it('decorates the request and disposes on response', async () => {
    const hooks: Record<string, (req: Record<string, unknown>, reply: unknown) => unknown> = {};
    const fake = {
      decorateRequest: () => undefined,
      addHook: (name: string, fn: (req: Record<string, unknown>, reply: unknown) => unknown) => {
        hooks[name] = fn;
      },
    };
    let done = false;
    ormitFastify(factory())(fake, {}, () => (done = true));
    expect(done).toBe(true);

    const request: Record<string, unknown> = {};
    await hooks['onRequest']!(request, {});
    expect(request['db']).toBeInstanceOf(AppDb);

    const db = request['db'] as AppDb;
    db.users.add(Object.assign(new User(), { name: 'B' }));
    await hooks['onResponse']!(request, {});
    expect(await db.saveChanges()).toBe(0); // disposed
  });
});

describe('NestJS providers', () => {
  it('exposes a factory singleton and a REQUEST-scoped context', () => {
    const providers: NestProvider[] = ormitNestProviders(AppDb, {
      engine: new InMemoryEngine(),
    });
    expect(providers).toHaveLength(2);

    const [factoryProvider, contextProvider] = providers;
    expect(factoryProvider!.provide).toBe(ORMIT_FACTORY);
    const built = factoryProvider!.useFactory();

    expect(contextProvider!.provide).toBe(AppDb);
    expect(contextProvider!.scope).toBe('REQUEST');
    expect(contextProvider!.inject).toEqual([ORMIT_FACTORY]);
    const ctx = contextProvider!.useFactory(built);
    expect(ctx).toBeInstanceOf(AppDb);
  });
});
