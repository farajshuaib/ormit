/** Base class for all Ormit errors. Every error carries a stable OMT code. */
export abstract class OrmitError extends Error {
  abstract readonly code: `OMT${number}`;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown at query build time when an expression cannot be translated. Never silent. */
export class TranslationError extends OrmitError {
  readonly code = 'OMT1001';
}

export class EntityNotFoundError extends OrmitError {
  readonly code = 'OMT1002';
}

export class ConcurrencyError extends OrmitError {
  readonly code = 'OMT1003';
  constructor(message: string, readonly entries: readonly unknown[]) {
    super(message);
  }
}

/** A single model-validation problem. Mirrors metadata/diagnostics. */
export interface ModelDiagnostic {
  readonly code: `OMT${number}`;
  readonly message: string;
  readonly entity?: string;
  readonly member?: string;
}

/**
 * Raised eagerly when a model fails validation. Carries every diagnostic found
 * in one pass; `code` is the first (primary) one for convenient assertions.
 */
export class ModelValidationError extends OrmitError {
  readonly code: `OMT${number}`;
  readonly diagnostics: readonly ModelDiagnostic[];
  constructor(message: string, diagnostics: readonly ModelDiagnostic[] = []) {
    super(message);
    this.diagnostics = diagnostics;
    this.code = diagnostics[0]?.code ?? 'OMT1200';
  }
}
