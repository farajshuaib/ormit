/** Immutable Queryable<T>: every method forks a new query over the IR. */
import type { AggregateSpec, BoolExprNode, IncludeNode, Ordering, SelectExpr } from '../ir/nodes.js';
import { irHash } from '../ir/hash.js';
import {
  recordPath,
  recordPredicate,
  recordProjection,
  type BoolExpr,
  type EntityRef,
} from '../expressions/recorder.js';
import type { GenContext, OrmEngine, Row } from '../contracts/engine.js';
import { EntityNotFoundError, TranslationError } from '../errors.js';
import type { ModelSnapshot } from '../metadata/snapshot.js';
import type { ValueConverterRegistry } from '../metadata/converters.js';
import { prepareSelect } from '../pipeline/prepare.js';
import type { Lru } from '../pipeline/cache.js';
import type { CompiledCommand } from '../contracts/engine.js';
import type { ChangeTracker } from '../tracking/tracker.js';
import type { NormalizerPass } from '../plugins/types.js';
import { loadIncludes, type ContextServices } from './include-loader.js';

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

type Materializer<T> = (row: Row) => T;

/** Per-query flags that steer the pipeline (not part of the IR). */
export interface QueryOptions {
  readonly ignoreQueryFilters: boolean;
  readonly noTracking: boolean;
}

const DEFAULT_OPTIONS: QueryOptions = { ignoreQueryFilters: false, noTracking: false };

/** Metadata + flags needed to normalize a query. Absent for raw queryables. */
export interface PlanContext {
  readonly snapshot: ModelSnapshot;
  readonly options: QueryOptions;
  /** Shared, context-scoped compiled-query cache (optional). */
  readonly cache?: Lru<string, CompiledCommand>;
  /** Change tracker + entity name; present ⇒ results are tracked (dedup). */
  readonly tracker?: ChangeTracker;
  readonly entityName?: string;
  /** Context services for eager-loading follow-up queries (Include). */
  readonly services?: ContextServices;
  /** Plugin-contributed IR→IR passes (e.g. a tenant filter). */
  readonly normalizerPasses?: readonly NormalizerPass[];
  /** Value converters, applied to filter constants over converted columns. */
  readonly converters?: ValueConverterRegistry;
}

/** Cursor into the include tree for ThenInclude resolution. */
interface IncludeCursor {
  readonly path: readonly number[];
  readonly entity: string;
}

export class Queryable<T extends object> {
  /** @internal */
  constructor(
    protected readonly ir: SelectExpr,
    protected readonly engine: OrmEngine,
    protected readonly genCtx: GenContext,
    protected readonly materialize: Materializer<T>,
    protected readonly plan?: PlanContext,
    /** Set for `fromSql` queries: a pre-compiled raw command (no composition). */
    protected readonly rawCommand?: CompiledCommand,
    /** Cursor for ThenInclude chaining (internal). */
    protected readonly includeCursor?: IncludeCursor,
  ) {}

  /** fromSql results are terminal in this version — reject LINQ composition. */
  private assertComposable(): void {
    if (this.rawCommand) {
      throw new EntityNotFoundError(
        'A fromSql() query cannot be further composed with query operators yet.',
      );
    }
  }

  protected fork(patch: Partial<SelectExpr>): Queryable<T> {
    this.assertComposable();
    return new Queryable(
      { ...this.ir, ...patch },
      this.engine,
      this.genCtx,
      this.materialize,
      this.plan,
      undefined,
      this.includeCursor,
    );
  }

  private withOptions(patch: Partial<QueryOptions>): Queryable<T> {
    this.assertComposable();
    const options = { ...(this.plan?.options ?? DEFAULT_OPTIONS), ...patch };
    const plan: PlanContext | undefined = this.plan ? { ...this.plan, options } : undefined;
    return new Queryable(this.ir, this.engine, this.genCtx, this.materialize, plan);
  }

  where(predicate: (x: EntityRef<T>) => BoolExpr): Queryable<T> {
    const node = recordPredicate(predicate);
    const merged: BoolExprNode = this.ir.predicate
      ? { kind: 'logical', op: 'and', operands: [this.ir.predicate, node] }
      : node;
    return this.fork({ predicate: merged });
  }

  orderBy(selector: (x: EntityRef<T>) => unknown): OrderedQueryable<T> {
    return this.addOrdering(selector, 'asc');
  }
  orderByDescending(selector: (x: EntityRef<T>) => unknown): OrderedQueryable<T> {
    return this.addOrdering(selector, 'desc');
  }
  /** Append an ordering and re-type the result as ordered (unlocks thenBy). */
  protected addOrdering(
    sel: (x: EntityRef<T>) => unknown,
    direction: Ordering['direction'],
  ): OrderedQueryable<T> {
    this.assertComposable();
    const ordering: Ordering = { path: recordPath(sel), direction };
    return new OrderedQueryable<T>(
      { ...this.ir, orderings: [...this.ir.orderings, ordering] },
      this.engine,
      this.genCtx,
      this.materialize,
      this.plan,
      undefined,
      this.includeCursor,
    );
  }

  skip(n: number): Queryable<T> {
    return this.fork({ skip: n });
  }
  take(n: number): Queryable<T> {
    return this.fork({ take: n });
  }
  distinct(): Queryable<T> {
    return this.fork({ distinct: true });
  }

  /** Eager-load a navigation (split query by default, ADR-003). */
  include(selector: (x: EntityRef<T>) => unknown): Queryable<T> {
    this.assertComposable();
    const node = this.resolveInclude(this.ir.entity, recordPath(selector)[0]);
    const includes = [...(this.ir.includes ?? []), node];
    const cursor: IncludeCursor = { path: [includes.length - 1], entity: node.target };
    return this.withIncludes(includes, cursor);
  }

  /** Continue eager-loading from the last included navigation. */
  thenInclude(selector: (x: EntityRef<unknown>) => unknown): Queryable<T> {
    if (!this.includeCursor) {
      throw new TranslationError('thenInclude() must follow include().');
    }
    const child = this.resolveInclude(this.includeCursor.entity, recordPath(selector)[0]);
    const [includes, childIndex] = attachChild(
      [...(this.ir.includes ?? [])],
      this.includeCursor.path,
      child,
    );
    const cursor: IncludeCursor = {
      path: [...this.includeCursor.path, childIndex],
      entity: child.target,
    };
    return this.withIncludes(includes, cursor);
  }

  private resolveInclude(fromEntity: string, navName: string | undefined): IncludeNode {
    const meta = this.plan?.snapshot.entity(fromEntity);
    const nav = navName ? meta?.navigations.find((n) => n.name === navName) : undefined;
    if (!nav) {
      throw new TranslationError(`'${navName}' is not a navigation on '${fromEntity}'.`);
    }
    return {
      navigation: nav.name,
      target: nav.target,
      collection: nav.collection,
      foreignKey: nav.foreignKey,
      principalKey: nav.principalKey,
      children: [],
    };
  }

  private withIncludes(includes: IncludeNode[], cursor: IncludeCursor): Queryable<T> {
    return new Queryable(
      { ...this.ir, includes },
      this.engine,
      this.genCtx,
      this.materialize,
      this.plan,
      undefined,
      cursor,
    );
  }

  asNoTracking(): Queryable<T> {
    return this.withOptions({ noTracking: true });
  }
  ignoreQueryFilters(): Queryable<T> {
    return this.withOptions({ ignoreQueryFilters: true });
  }

  /** Project each row into a new shape: `select(x => ({ id: x.id }))`. */
  select<R extends Record<string, unknown>>(
    projector: (x: EntityRef<T>) => R,
  ): Queryable<{ [K in keyof R]: unknown }> {
    this.assertComposable();
    const projection = recordProjection(projector as (x: EntityRef<unknown>) => Record<string, unknown>);
    // Projections are not entities — drop the tracker so rows aren't tracked.
    const plan: PlanContext | undefined = this.plan
      ? { snapshot: this.plan.snapshot, options: this.plan.options, ...(this.plan.cache ? { cache: this.plan.cache } : {}) }
      : undefined;
    return new Queryable(
      { ...this.ir, projection },
      this.engine,
      this.genCtx,
      (row) => row as { [K in keyof R]: unknown },
      plan,
    );
  }

  /** Materialize a row, registering entity results in the identity map. */
  protected materializeTracked(row: Row): T {
    const entity = this.materialize(row);
    if (
      this.plan?.tracker &&
      this.plan.entityName &&
      !this.plan.options.noTracking &&
      this.ir.projection === undefined
    ) {
      return this.plan.tracker.registerQueried(entity as object, this.plan.entityName) as T;
    }
    return entity;
  }

  // ---- terminals ----
  async toList(): Promise<T[]> {
    const rows = await this.engine.executor.query(this.compile(this.ir));
    const entities = rows.map((r) => this.materializeTracked(r));
    await this.applyIncludes(entities);
    return entities;
  }

  async first(): Promise<T> {
    const found = await this.firstOrNull();
    if (found === null) throw new EntityNotFoundError('Sequence contains no elements.');
    return found;
  }
  async firstOrNull(): Promise<T | null> {
    const rows = await this.engine.executor.query(this.compile({ ...this.ir, take: 1 }));
    const row = rows[0];
    if (row === undefined) return null;
    const entity = this.materializeTracked(row);
    await this.applyIncludes([entity]);
    return entity;
  }

  async single(): Promise<T> {
    const found = await this.singleOrNull();
    if (found === null) throw new EntityNotFoundError('Sequence contains no elements.');
    return found;
  }
  async singleOrNull(): Promise<T | null> {
    // Fetch two so we can detect (and reject) a non-unique result.
    const rows = await this.engine.executor.query(this.compile({ ...this.ir, take: 2 }));
    if (rows.length > 1) {
      throw new EntityNotFoundError('Sequence contains more than one element.');
    }
    const row = rows[0];
    if (row === undefined) return null;
    const entity = this.materializeTracked(row);
    await this.applyIncludes([entity]);
    return entity;
  }

  /** Run the split-query eager loaders for any Includes on this query. */
  private async applyIncludes(entities: readonly T[]): Promise<void> {
    if (this.ir.includes?.length && this.plan?.services) {
      await loadIncludes(entities as readonly object[], this.ir.includes, this.plan.services);
    }
  }

  async count(): Promise<number> {
    return this.scalar({ fn: 'count' });
  }
  async any(): Promise<boolean> {
    return (await this.take(1).toList()).length > 0;
  }
  async sum(selector: (x: EntityRef<T>) => number): Promise<number> {
    return this.scalar({ fn: 'sum', path: recordPath(selector) });
  }
  async avg(selector: (x: EntityRef<T>) => number): Promise<number> {
    return this.scalar({ fn: 'avg', path: recordPath(selector) });
  }
  async min(selector: (x: EntityRef<T>) => number): Promise<number> {
    return this.scalar({ fn: 'min', path: recordPath(selector) });
  }
  async max(selector: (x: EntityRef<T>) => number): Promise<number> {
    return this.scalar({ fn: 'max', path: recordPath(selector) });
  }

  private async scalar(aggregate: AggregateSpec): Promise<number> {
    const rows = await this.engine.executor.query(
      this.compile({ ...this.ir, aggregate, orderings: [] }),
    );
    return Number(rows[0]?.['value'] ?? 0);
  }

  async toPage(page: number, pageSize: number): Promise<Page<T>> {
    const [items, total] = await Promise.all([
      this.skip((page - 1) * pageSize).take(pageSize).toList(),
      this.count(),
    ]);
    return { items, total, page, pageSize };
  }

  /** Run the pipeline (normalize → optimize) and compile to an engine command,
   * memoizing the compiled result by structural hash. */
  private compile(ir: SelectExpr): CompiledCommand {
    if (this.rawCommand) return this.rawCommand;
    const prepared = this.prepare(ir);
    const key = irHash(prepared);
    const cache = this.plan?.cache;
    const hit = cache?.get(key);
    if (hit) return hit;
    const cmd = this.engine.generator.compileSelect(prepared, this.genCtx);
    const result: CompiledCommand = { ...cmd, irHash: cmd.irHash || key };
    cache?.set(key, result);
    return result;
  }

  private prepare(ir: SelectExpr): SelectExpr {
    if (!this.plan) return ir;
    return prepareSelect(
      ir,
      this.plan.snapshot,
      { ignoreQueryFilters: this.plan.options.ignoreQueryFilters },
      this.plan.normalizerPasses,
      this.plan.converters,
    );
  }
}

/**
 * A {@link Queryable} that already carries at least one ordering. Returned by
 * `orderBy`/`orderByDescending`, it additionally exposes `thenBy`/`thenByDescending`
 * for secondary sort keys — mirroring EF Core's `IOrderedQueryable<T>`, so a
 * `thenBy` before an `orderBy` doesn't type-check.
 */
export class OrderedQueryable<T extends object> extends Queryable<T> {
  /** Add a secondary ascending sort key, applied after the previous orderings. */
  thenBy(selector: (x: EntityRef<T>) => unknown): OrderedQueryable<T> {
    return this.addOrdering(selector, 'asc');
  }
  /** Add a secondary descending sort key, applied after the previous orderings. */
  thenByDescending(selector: (x: EntityRef<T>) => unknown): OrderedQueryable<T> {
    return this.addOrdering(selector, 'desc');
  }
}

/** Immutably attach `child` to the include node at `path`; return the new tree
 * and the child's index for the next cursor. */
function attachChild(
  includes: IncludeNode[],
  path: readonly number[],
  child: IncludeNode,
): [IncludeNode[], number] {
  const index = path[0]!;
  const node = includes[index]!;
  if (path.length === 1) {
    const childIndex = node.children.length;
    const updated: IncludeNode = { ...node, children: [...node.children, child] };
    return [includes.map((n, i) => (i === index ? updated : n)), childIndex];
  }
  const [newChildren, childIndex] = attachChild([...node.children], path.slice(1), child);
  const updated: IncludeNode = { ...node, children: newChildren };
  return [includes.map((n, i) => (i === index ? updated : n)), childIndex];
}
