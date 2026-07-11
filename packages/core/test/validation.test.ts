/**
 * The Phase 2 diagnostics gate: 25 curated invalid models, each of which must
 * surface its documented `OMT12xx` code (see docs/diagnostics.md).
 */
import { describe, expect, it } from 'vitest';
import {
  ModelBuilder,
  ModelSnapshot,
  ModelValidationError,
  type DiagnosticCode,
} from '@ormit/core';

// Minimal domain classes; only names matter to the builder.
class A {} class B {} class Target {} class Profile {}
class Role {} class JoinAB {} class Address {}

/** Build a model, expect it to throw, and return the emitted codes. */
function codesFor(build: (m: ModelBuilder) => void): DiagnosticCode[] {
  const m = new ModelBuilder();
  build(m);
  try {
    ModelSnapshot.build(m); // validates eagerly
  } catch (err) {
    if (err instanceof ModelValidationError) {
      return err.diagnostics.map((d) => d.code as DiagnosticCode);
    }
    throw err;
  }
  throw new Error('expected the model to be invalid');
}

interface Fixture {
  readonly code: DiagnosticCode;
  readonly name: string;
  readonly build: (m: ModelBuilder) => void;
}

const fixtures: Fixture[] = [
  {
    code: 'OMT1201',
    name: 'entity with no discoverable key',
    build: (m) => m.entity(A, (e) => e.property((x) => x.name)),
  },
  {
    code: 'OMT1201',
    name: 'entity with only navigations, no key',
    build: (m) => {
      m.entity(B, (e) => e.hasKey('id'));
      m.entity(A, (e) => e.hasMany(B, (x) => x.items).withOne());
    },
  },
  {
    code: 'OMT1202',
    name: 'key property collides with a navigation',
    build: (m) => {
      m.entity(Profile, (e) => e.hasKey('id'));
      m.entity(A, (e) => {
        e.hasKey('profile');
        e.hasOne(Profile, (x) => x.profile).withOne();
      });
    },
  },
  {
    code: 'OMT1203',
    name: 'entity registered twice',
    build: (m) => {
      m.entity(A, (e) => e.hasKey('id'));
      m.entity(A, (e) => e.hasKey('id'));
    },
  },
  {
    code: 'OMT1204',
    name: 'two entities mapped to the same table',
    build: (m) => {
      m.entity(A, (e) => e.toTable('shared').hasKey('id'));
      m.entity(B, (e) => e.toTable('shared').hasKey('id'));
    },
  },
  {
    code: 'OMT1205',
    name: 'two properties mapped to the same column',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.a).hasColumnName('c');
        e.property((x) => x.b).hasColumnName('c');
      }),
  },
  {
    code: 'OMT1206',
    name: 'negative max length',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.name).hasMaxLength(-1);
      }),
  },
  {
    code: 'OMT1206',
    name: 'non-integer max length',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.name).hasMaxLength(1.5);
      }),
  },
  {
    code: 'OMT1207',
    name: 'foreign key arity mismatch',
    build: (m) => {
      m.entity(Target, (e) => e.hasKey('id'));
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasOne(Target, (x) => x.target).withMany().hasForeignKey('a', 'b');
      });
    },
  },
  {
    code: 'OMT1208',
    name: 'relationship principal has no key',
    build: (m) => {
      m.entity(Target, (e) => e.property((x) => x.note)); // no key
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasOne(Target, (x) => x.target).withMany();
      });
    },
  },
  {
    code: 'OMT1209',
    name: 'duplicate discriminator value on a shared table',
    build: (m) => {
      m.entity(A, (e) => e.toTable('t').hasKey('id').hasDiscriminator('kind', 'X'));
      m.entity(B, (e) => e.toTable('t').hasKey('id').hasDiscriminator('kind', 'X'));
    },
  },
  {
    code: 'OMT1210',
    name: 'composite key lists a property twice',
    build: (m) => m.entity(A, (e) => e.hasKey('id', 'id')),
  },
  {
    code: 'OMT1211',
    name: 'seed row missing a key value',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasData({ name: 'x' } as never);
      }),
  },
  {
    code: 'OMT1211',
    name: 'seed row missing part of a composite key',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('a', 'b');
        e.hasData({ a: 1 } as never);
      }),
  },
  {
    code: 'OMT1212',
    name: 'seed row references an unknown property',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasData({ id: 1, bogus: 2 } as never);
      }),
  },
  {
    code: 'OMT1213',
    name: 'index references an unknown property',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasIndex('nope' as never);
      }),
  },
  {
    code: 'OMT1214',
    name: 'index declares no properties',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasIndex();
      }),
  },
  {
    code: 'OMT1215',
    name: 'conversion with an empty name',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.name).hasConversion('');
      }),
  },
  {
    code: 'OMT1216',
    name: 'owned type declares its own key',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.ownsOne(Address, (x) => x.address, (a) => a.hasKey('id'));
      }),
  },
  {
    code: 'OMT1217',
    name: 'empty column name',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.name).hasColumnName('');
      }),
  },
  {
    code: 'OMT1218',
    name: 'key marked as a concurrency token',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.id).isConcurrencyToken();
      }),
  },
  {
    code: 'OMT1219',
    name: 'empty table name',
    build: (m) => m.entity(A, (e) => e.toTable('').hasKey('id')),
  },
  {
    code: 'OMT1220',
    name: 'many-to-many join entity not registered',
    build: (m) => {
      m.entity(Role, (e) => e.hasKey('id'));
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasMany(Role, (x) => x.roles).withMany((r) => r.items, JoinAB);
      });
    },
  },
  {
    code: 'OMT1221',
    name: 'navigation name collides with a scalar property',
    build: (m) => {
      m.entity(Target, (e) => e.hasKey('id'));
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.target);
        e.hasOne(Target, (x) => x.target).withMany();
      });
    },
  },
  {
    code: 'OMT1222',
    name: 'discriminator declared without a value',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.hasDiscriminator('kind');
      }),
  },
  {
    code: 'OMT1223',
    name: 'both hasDefault and hasDefaultSql set',
    build: (m) =>
      m.entity(A, (e) => {
        e.hasKey('id');
        e.property((x) => x.name).hasDefault('x').hasDefaultSql('now()');
      }),
  },
];

describe('model validation · curated invalid fixtures', () => {
  it('provides at least 25 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
  });

  for (const fx of fixtures) {
    it(`${fx.code}: ${fx.name}`, () => {
      expect(codesFor(fx.build)).toContain(fx.code);
    });
  }

  it('covers every documented diagnostic code', () => {
    const covered = new Set(fixtures.map((f) => f.code));
    const documented = Array.from({ length: 23 }, (_, i) => `OMT${1201 + i}` as DiagnosticCode);
    expect([...documented].filter((c) => !covered.has(c))).toEqual([]);
  });
});
