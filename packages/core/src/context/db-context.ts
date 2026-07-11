import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompiledCommand, ExecuteResult, GenContext, OrmEngine, Row } from '../contracts/engine.js';
import type { BoolExprNode, IncludeNode, SelectExpr } from '../ir/nodes.js';
import { irHash } from '../ir/hash.js';
import { ModelBuilder, ModelSnapshot, type Ctor, type EntityMeta } from './model.js';
import { tableNameFor } from '../metadata/index.js';
import { Queryable } from './queryable.js';
import { Lru } from '../pipeline/cache.js';
import { prepareSelect } from '../pipeline/prepare.js';
import { ChangeTracker, EntityEntry } from '../tracking/tracker.js';
import { planSave } from '../tracking/save.js';
import { loadIncludes, type ContextServices, type LoadInfo } from './include-loader.js';
import { LazyRef, LazyCollection } from './lazy.js';
import type {
  Interceptors,
  NormalizerPass,
  OrmPlugin,
  SavingContext,
} from '../plugins/types.js';
import { ConcurrencyError, TranslationError } from '../errors.js';

export interface OrmWarning {
  readonly code: `OMT${number}`;
  readonly message: string;
}

export interface DbContextOptions {
  readonly engine: OrmEngine;
  /** Enable diagnostics (e.g. the N+1 detector). */
  readonly diagnostics?: boolean;
  /** Sink for diagnostics warnings. */
  readonly onWarning?: (warning: OrmWarning) => void;
  /** Plugins extending the model, pipeline, and lifecycle. */
  readonly plugins?: readonly OrmPlugin[];
}

/** Number of individual single-entity loads before an N+1 is suspected. */
const N_PLUS_ONE_THRESHOLD = 10;

interface SetContext<T extends object> {
  engine: OrmEngine;
  genCtx: GenContext;
  meta: EntityMeta;
  snapshot: ModelSnapshot;
  cache: Lru<string, CompiledCommand>;
  tracker: ChangeTracker;
  services: ContextServices;
  normalizerPasses: readonly NormalizerPass[];
  reverseColumns: ReadonlyMap<string, string>;
}

export class DbSet<T extends object> extends Queryable<T> {
  private readonly meta: EntityMeta;
  /** @internal */
  constructor(
    ctor: Ctor<T>,
    private readonly ctx: SetContext<T>,
  ) {
    super(
      { kind: 'select', entity: ctx.meta.name, orderings: [] },
      ctx.engine,
      ctx.genCtx,
      (row) => {
        const entity = Object.create(ctor.prototype) as Record<string, unknown>;
        for (const [column, value] of Object.entries(row)) {
          entity[ctx.reverseColumns.get(column) ?? column] = value;
        }
        return entity as T;
      },
      {
        snapshot: ctx.snapshot,
        options: { ignoreQueryFilters: false, noTracking: false },
        cache: ctx.cache,
        tracker: ctx.tracker,
        entityName: ctx.meta.name,
        services: ctx.services,
        normalizerPasses: ctx.normalizerPasses,
      },
    );
    this.meta = ctx.meta;
  }

  add(entity: T): T {
    this.ctx.tracker.track(entity, this.meta.name, 'Added');
    return entity;
  }
  addRange(entities: readonly T[]): void {
    for (const e of entities) this.add(e);
  }

  /** Attach an existing (unchanged) entity so edits are tracked. */
  attach(entity: T): T {
    this.ctx.tracker.track(entity, this.meta.name, 'Unchanged');
    return entity;
  }

  remove(entity: T): void {
    this.ctx.tracker.remove(entity, this.meta.name);
  }
  removeRange(entities: readonly T[]): void {
    for (const e of entities) this.remove(e);
  }

  /** Identity-map lookup by primary key, falling back to a keyed query. */
  async find(...keyValues: unknown[]): Promise<T | null> {
    const tracked = this.ctx.tracker.findByKey(this.meta.name, keyValues);
    if (tracked) return tracked as T;
    const predicate = eqAll(this.meta.key.map((k, i) => [k, keyValues[i]] as const));
    return this.fork({ predicate }).firstOrNull();
  }

  /** Run a raw, parameterized SQL query and materialize rows as `T`. */
  fromSql(strings: TemplateStringsArray, ...params: unknown[]): Queryable<T> {
    const cmd = this.ctx.engine.generator.compileRaw([...strings], params, this.ctx.genCtx);
    return new Queryable<T>(this.ir, this.engine, this.genCtx, this.materialize, this.plan, cmd);
  }
}

export abstract class DbContext {
  private readonly engine: OrmEngine;
  private readonly modelSnapshot: ModelSnapshot;
  private readonly sets = new Map<Ctor<object>, DbSet<object>>();
  private readonly queryCache = new Lru<string, CompiledCommand>(1024);
  private readonly tracker: ChangeTracker;
  private readonly ambient = new AsyncLocalStorage<boolean>();
  private readonly services: ContextServices;
  private readonly diagnostics: boolean;
  private readonly onWarning?: (warning: OrmWarning) => void;
  private readonly loadCounts = new Map<string, number>();
  private readonly warned = new Set<string>();
  private readonly plugins: readonly OrmPlugin[];
  private readonly pluginPasses: readonly NormalizerPass[];

  constructor(options: DbContextOptions) {
    this.engine = options.engine;
    this.diagnostics = options.diagnostics ?? false;
    if (options.onWarning) this.onWarning = options.onWarning;
    this.plugins = options.plugins ?? [];
    this.pluginPasses = this.plugins.flatMap((p) => p.normalizerPasses ?? []);

    const builder = new ModelBuilder();
    this.onModelCreating(builder);
    for (const plugin of this.plugins) plugin.configureModel?.(builder);
    this.modelSnapshot = ModelSnapshot.build(builder);

    this.tracker = new ChangeTracker(this.modelSnapshot);
    this.services = {
      snapshot: this.modelSnapshot,
      runSelect: (select) => this.runSelect(select),
      onLoad: (info) => this.observeLoad(info),
    };
  }

  protected abstract onModelCreating(model: ModelBuilder): void;

  protected set<T extends object>(ctor: Ctor<T>): DbSet<T> {
    const cached = this.sets.get(ctor as Ctor<object>);
    if (cached) return cached as DbSet<T>;
    const configured = this.modelSnapshot.entity(ctor.name);
    const meta: EntityMeta = configured
      ? { name: configured.name, table: configured.table, key: configured.key }
      : { name: ctor.name, table: tableNameFor(ctor.name), key: ['id'] };
    const tables = new Map(this.modelSnapshot.tables);
    if (!tables.has(meta.name)) tables.set(meta.name, meta.table);
    const reverseColumns = new Map<string, string>();
    for (const p of configured?.properties ?? []) {
      if (p.column !== p.name) reverseColumns.set(p.column, p.name);
    }
    const set = new DbSet<T>(ctor, {
      engine: this.engine,
      genCtx: { tables },
      meta,
      snapshot: this.modelSnapshot,
      cache: this.queryCache,
      tracker: this.tracker,
      services: this.services,
      normalizerPasses: this.pluginPasses,
      reverseColumns,
    });
    this.sets.set(ctor as Ctor<object>, set as DbSet<object>);
    return set;
  }

  /** The change-tracking entry for an entity (begins tracking if new). */
  entry<T extends object>(entity: T): EntityEntry<T> {
    const existing = this.tracker.entry(entity) as EntityEntry<T> | undefined;
    const entry = existing ?? this.tracker.track(entity, entity.constructor.name, 'Unchanged');
    entry.loader = (navigation) => this.load(entity, navigation);
    return entry;
  }

  /** Explicitly load one navigation on a single entity (split query). */
  private async load(entity: object, navigation: string): Promise<void> {
    const meta = this.modelSnapshot.entity(entity.constructor.name);
    const nav = meta?.navigations.find((n) => n.name === navigation);
    if (!nav) {
      throw new TranslationError(
        `'${navigation}' is not a navigation on '${entity.constructor.name}'.`,
      );
    }
    const node: IncludeNode = {
      navigation: nav.name,
      target: nav.target,
      collection: nav.collection,
      foreignKey: nav.foreignKey,
      principalKey: nav.principalKey,
      children: [],
    };
    await loadIncludes([entity], [node], this.services);
  }

  /** An explicit lazy reference over a to-one navigation (ADR-004). */
  lazyReference<N extends object>(entity: object, navigation: string): LazyRef<N> {
    return new LazyRef<N>(async () => {
      await this.load(entity, navigation);
      return ((entity as Record<string, unknown>)[navigation] as N | null) ?? null;
    });
  }

  /** An explicit lazy collection over a to-many navigation (ADR-004). */
  lazyCollection<N extends object>(entity: object, navigation: string): LazyCollection<N> {
    return new LazyCollection<N>(async () => {
      await this.load(entity, navigation);
      return ((entity as Record<string, unknown>)[navigation] as readonly N[]) ?? [];
    });
  }

  /** Compile + run a select through the pipeline (used by eager loading). */
  private async runSelect(select: SelectExpr): Promise<readonly Row[]> {
    const prepared = prepareSelect(select, this.modelSnapshot, {}, this.pluginPasses);
    const genCtx: GenContext = { tables: this.modelSnapshot.tables };
    const cmd = this.engine.generator.compileSelect(prepared, genCtx);
    return this.engine.executor.query({ ...cmd, irHash: cmd.irHash || irHash(prepared) });
  }

  /** N+1 detector: many single-entity loads of one type suggests a missing
   * Include. Fires once per entity in diagnostics mode. */
  private observeLoad(info: LoadInfo): void {
    if (!this.diagnostics || info.rootCount !== 1) return;
    const count = (this.loadCounts.get(info.entity) ?? 0) + 1;
    this.loadCounts.set(info.entity, count);
    if (count >= N_PLUS_ONE_THRESHOLD && !this.warned.has(info.entity)) {
      this.warned.add(info.entity);
      this.onWarning?.({
        code: 'OMT2001',
        message:
          `Possible N+1: '${info.entity}' was loaded individually ${count}+ times. ` +
          `Use .include(x => x.${info.navigation}) to batch it.`,
      });
    }
  }

  /** Facade for database-level operations (transactions, raw SQL). */
  get database(): DatabaseFacade {
    return {
      transaction: <R>(work: () => Promise<R>): Promise<R> => this.runTransaction(work),
    };
  }

  private async runTransaction<R>(work: () => Promise<R>): Promise<R> {
    if (this.ambient.getStore()) return work(); // nested → join the ambient tx
    const scoped = () => this.ambient.run(true, work);
    return this.engine.executor.transaction ? this.engine.executor.transaction(scoped) : scoped();
  }

  /**
   * Persist tracked changes atomically. Detect → plan (topo-sorted) → execute
   * in a transaction → write generated keys back → refresh snapshots.
   */
  async saveChanges(): Promise<number> {
    this.tracker.detectChanges();
    // Plugins may re-state entries (soft-delete rewrite, timestamps, tenant id).
    const savingCtx: SavingContext = {
      entries: this.tracker.allEntries(),
      tracker: this.tracker,
      model: this.modelSnapshot,
    };
    await this.runInterceptors('savingChanges', savingCtx);
    this.tracker.detectChanges();
    if (!this.tracker.hasChanges()) return 0;

    const steps = planSave(this.tracker, this.modelSnapshot);
    const genCtx: GenContext = { tables: this.modelSnapshot.tables };
    let affected = 0;

    const run = async (): Promise<void> => {
      for (const step of steps) {
        const cmd: CompiledCommand = (() => {
          const c = this.engine.generator.compileWrite(step.op, genCtx);
          return { ...c, irHash: c.irHash || irHash(step.op) };
        })();
        this.emitCommand('commandExecuting', cmd);
        const result = await this.engine.executor.execute(cmd);
        this.emitCommand('commandExecuted', cmd, result);
        if (step.concurrency && result.affected === 0) {
          throw new ConcurrencyError(
            `Concurrency conflict: ${step.entry.entityName} was modified or deleted by another process.`,
            [step.entry],
          );
        }
        affected += result.affected;
        if (step.op.kind === 'insert') {
          const generated = result.returning?.[0];
          if (generated) writeBack(step.entry.entity, generated, step.reverseColumns);
        }
      }
    };

    const exec = this.engine.executor;
    if (this.ambient.getStore() || !exec.transaction) await run();
    else await exec.transaction(run);

    this.tracker.acceptChanges();
    await this.runInterceptors('savedChanges', savingCtx);
    return affected;
  }

  private async runInterceptors(
    hook: 'savingChanges' | 'savedChanges',
    ctx: SavingContext,
  ): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.interceptors?.[hook]?.(ctx);
    }
  }

  private emitCommand(
    hook: 'commandExecuting' | 'commandExecuted',
    cmd: CompiledCommand,
    result?: ExecuteResult,
  ): void {
    for (const plugin of this.plugins) {
      const interceptors = plugin.interceptors;
      if (!interceptors) continue;
      if (hook === 'commandExecuted') interceptors.commandExecuted?.(cmd, result!);
      else interceptors.commandExecuting?.(cmd);
    }
  }

  /** Detach everything and release resources. */
  async [Symbol.asyncDispose](): Promise<void> {
    this.tracker.clear();
    this.sets.clear();
    this.queryCache.clear();
  }
}

export interface DatabaseFacade {
  transaction<R>(work: () => Promise<R>): Promise<R>;
}

function eqAll(pairs: readonly (readonly [string, unknown])[]): BoolExprNode {
  const nodes: BoolExprNode[] = pairs.map(([prop, value]) => ({
    kind: 'binary',
    op: 'eq',
    left: { kind: 'column', path: [prop] },
    right: { kind: 'constant', value },
  }));
  return nodes.length === 1 ? nodes[0]! : { kind: 'logical', op: 'and', operands: nodes };
}

function writeBack(entity: object, row: Row, reverseColumns: ReadonlyMap<string, string>): void {
  const target = entity as Record<string, unknown>;
  for (const [column, value] of Object.entries(row)) {
    target[reverseColumns.get(column) ?? column] = value;
  }
}
