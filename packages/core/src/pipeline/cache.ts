/**
 * Compiled-query cache (plan §5 · S3): a bounded LRU that memoizes
 * `irHash → CompiledCommand`, so a query shape built and executed repeatedly
 * pays the normalize → optimize → generate cost only once. Constants are part
 * of the IR (and thus the hash), so a cache hit is always a safe reuse.
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity = 1024) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: delete + re-insert moves the key to the newest slot.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  clear(): void {
    this.map.clear();
  }
}
