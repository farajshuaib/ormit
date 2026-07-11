import { describe, expect, it } from 'vitest';
import { Lru } from '@ormit/core';

describe('Lru compiled-query cache', () => {
  it('stores and retrieves values', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    expect(lru.get('a')).toBe(1);
    expect(lru.has('a')).toBe(true);
    expect(lru.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3); // evicts 'a'
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.has('c')).toBe(true);
    expect(lru.size).toBe(2);
  });

  it('refreshes recency on get so the touched key survives', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // 'a' is now most-recent
    lru.set('c', 3); // evicts 'b', not 'a'
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
  });

  it('updates an existing key without growing', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('a', 2);
    expect(lru.get('a')).toBe(2);
    expect(lru.size).toBe(1);
  });

  it('clears', () => {
    const lru = new Lru<string, number>();
    lru.set('a', 1);
    lru.clear();
    expect(lru.size).toBe(0);
  });
});
