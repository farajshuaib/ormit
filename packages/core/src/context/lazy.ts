/**
 * Explicit lazy loading (ADR-004): `LazyRef<T>` / `LazyCollection<T>` are
 * opt-in wrappers with an awaited `.load()`. There are no synchronous getters
 * that secretly hit the database — loading is always explicit and async.
 */
export class LazyRef<T> {
  private isLoaded = false;
  private value: T | null = null;
  constructor(private readonly loader: () => Promise<T | null>) {}

  async load(): Promise<T | null> {
    if (!this.isLoaded) {
      this.value = await this.loader();
      this.isLoaded = true;
    }
    return this.value;
  }

  get loaded(): boolean {
    return this.isLoaded;
  }
  /** The loaded value, or null if not yet loaded. */
  get current(): T | null {
    return this.value;
  }
}

export class LazyCollection<T> {
  private isLoaded = false;
  private items: readonly T[] = [];
  constructor(private readonly loader: () => Promise<readonly T[]>) {}

  async load(): Promise<readonly T[]> {
    if (!this.isLoaded) {
      this.items = await this.loader();
      this.isLoaded = true;
    }
    return this.items;
  }

  get loaded(): boolean {
    return this.isLoaded;
  }
  get current(): readonly T[] {
    return this.items;
  }
}
