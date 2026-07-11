import { describe, expect, it } from 'vitest';
import { ChangeTracker, ModelBuilder, ModelSnapshot, planSave, topoSort } from '@ormit/core';

class User {
  id!: number;
  name!: string;
  version!: number;
}
class Post {
  id!: number;
  title!: string;
  author!: User;
}

function model(): ModelSnapshot {
  const m = new ModelBuilder();
  m.entity(User, (e) => {
    e.hasKey('id');
    e.property((x) => x.version).isConcurrencyToken();
  });
  m.entity(Post, (e) => {
    e.hasKey('id');
    e.hasOne(User, (x) => x.author).withMany().hasForeignKey('authorId');
  });
  return ModelSnapshot.build(m);
}

describe('ChangeTracker · state machine', () => {
  it('tracks Added and detects modifications by snapshot diff', () => {
    const tracker = new ChangeTracker(model());
    const u = Object.assign(new User(), { id: 1, name: 'A', version: 1 });
    const entry = tracker.track(u, 'User', 'Unchanged');

    tracker.detectChanges();
    expect(entry.state).toBe('Unchanged');

    u.name = 'B';
    tracker.detectChanges();
    expect(entry.state).toBe('Modified');
    expect(entry.modifiedProperties()).toEqual(['name']);
  });

  it('Added + remove ⇒ Detached', () => {
    const tracker = new ChangeTracker(model());
    const u = Object.assign(new User(), { id: 5, name: 'X', version: 1 });
    tracker.track(u, 'User', 'Added');
    tracker.remove(u, 'User');
    expect(tracker.entry(u)).toBeUndefined();
    expect(tracker.hasChanges()).toBe(false);
  });

  it('identity map dedupes queried entities by key', () => {
    const tracker = new ChangeTracker(model());
    const first = Object.assign(new User(), { id: 7, name: 'first', version: 1 });
    const canonical = tracker.registerQueried(first, 'User');
    expect(canonical).toBe(first);

    // A second materialization of the same key returns the tracked instance.
    const duplicate = Object.assign(new User(), { id: 7, name: 'stale', version: 1 });
    expect(tracker.registerQueried(duplicate, 'User')).toBe(first);
    expect(tracker.findByKey('User', [7])).toBe(first);
  });

  it('acceptChanges promotes Added/Modified to Unchanged and drops Deleted', () => {
    const tracker = new ChangeTracker(model());
    const a = Object.assign(new User(), { id: 1, name: 'A', version: 1 });
    const b = Object.assign(new User(), { id: 2, name: 'B', version: 1 });
    tracker.track(a, 'User', 'Added');
    tracker.track(b, 'User', 'Unchanged');
    tracker.remove(b, 'User'); // Deleted

    tracker.acceptChanges();
    expect(tracker.entry(a)!.state).toBe('Unchanged');
    expect(tracker.entry(b)).toBeUndefined();
  });
});

describe('save planning · topological order', () => {
  it('orders principals before dependents', () => {
    const order = topoSort(model());
    expect(order.indexOf('User')).toBeLessThan(order.indexOf('Post'));
  });

  it('emits inserts parent→child, deletes child→parent', () => {
    const tracker = new ChangeTracker(model());
    const u = Object.assign(new User(), { id: 1, name: 'A', version: 1 });
    const p = Object.assign(new Post(), { id: 1, title: 'T', authorId: 1 });
    tracker.track(u, 'User', 'Added');
    tracker.track(p, 'Post', 'Added');
    const inserts = planSave(tracker, model()).map((s) => s.op.entity);
    expect(inserts).toEqual(['User', 'Post']);

    const t2 = new ChangeTracker(model());
    t2.track(u, 'User', 'Unchanged');
    t2.track(p, 'Post', 'Unchanged');
    t2.remove(u, 'User');
    t2.remove(p, 'Post');
    const deletes = planSave(t2, model()).map((s) => s.op.entity);
    expect(deletes).toEqual(['Post', 'User']); // children first
  });

  it('an update carries only changed columns and a key+token predicate', () => {
    const tracker = new ChangeTracker(model());
    const u = Object.assign(new User(), { id: 3, name: 'A', version: 1 });
    tracker.track(u, 'User', 'Unchanged');
    u.name = 'B';
    tracker.detectChanges();
    const step = planSave(tracker, model())[0]!;
    expect(step.op).toMatchObject({ kind: 'update', values: { name: 'B' } });
    // predicate ANDs the key and the original concurrency-token value.
    expect(step.concurrency).toBe(true);
    expect(JSON.stringify(step.op)).toContain('version');
  });
});
