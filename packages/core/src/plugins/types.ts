/**
 * Plugin & interceptor surface (plan §4/§7, Phase 7).
 *
 * A plugin extends Ormit only through this public seam: it can shape the model,
 * add pipeline passes, and hook the save/command lifecycle. The first-party
 * plugins (soft-delete, timestamps, multitenancy) are built solely on this API
 * as a dogfood proof that it is sufficient.
 */
import type { CompiledCommand, ExecuteResult } from '../contracts/engine.js';
import type { SelectExpr } from '../ir/nodes.js';
import type { ModelBuilder } from '../metadata/builder.js';
import type { ModelSnapshot } from '../metadata/snapshot.js';
import type { ChangeTracker, EntityEntry } from '../tracking/tracker.js';

/** Passed to save interceptors; entries may be mutated (state/values). */
export interface SavingContext {
  readonly entries: readonly EntityEntry[];
  readonly tracker: ChangeTracker;
  readonly model: ModelSnapshot;
}

export interface Interceptors {
  /** Before change detection is finalized into ops. May re-state entries. */
  savingChanges(ctx: SavingContext): void | Promise<void>;
  /** After a successful save (snapshots refreshed). */
  savedChanges(ctx: SavingContext): void | Promise<void>;
  /** Around each executed write command. */
  commandExecuting(cmd: CompiledCommand): void;
  commandExecuted(cmd: CompiledCommand, result: ExecuteResult): void;
}

/** An IR→IR pass applied to every query after core normalization. */
export type NormalizerPass = (select: SelectExpr, model: ModelSnapshot) => SelectExpr;

export interface OrmPlugin {
  readonly name: string;
  /** Contribute to the model (query filters, shadow columns, …). Runs after
   * the user's onModelCreating. */
  configureModel?(model: ModelBuilder): void;
  /** Query pipeline passes (e.g. a dynamic tenant filter). */
  readonly normalizerPasses?: readonly NormalizerPass[];
  /** Lifecycle interceptors. */
  readonly interceptors?: Partial<Interceptors>;
}
