/**
 * Conventions engine (plan §5 · S2, Phase 2).
 *
 * Pure, side-effect-free functions that fill metadata gaps the user did not
 * configure explicitly. Precedence is `convention < decorator < fluent`, so
 * everything here is only ever consulted for slots left `undefined` by the
 * builder — a fluent call always wins.
 *
 * These functions are the branch-coverage target of the Phase 2 gate, so each
 * decision is written as an explicit, individually testable branch.
 */
import type { ClrType } from './types.js';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** Irregular plurals we special-case before rule-based pluralization. */
const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ['person', 'people'],
  ['child', 'children'],
  ['man', 'men'],
  ['woman', 'women'],
  ['foot', 'feet'],
  ['tooth', 'teeth'],
  ['goose', 'geese'],
  ['mouse', 'mice'],
]);

/** Words that are identical in singular and plural. */
const UNCOUNTABLE: ReadonlySet<string> = new Set([
  'sheep',
  'series',
  'species',
  'fish',
  'deer',
  'equipment',
  'information',
]);

/**
 * English-ish pluralizer for default table names. Case-insensitive on the
 * classification rules but preserves the input's leading case.
 */
export function pluralize(word: string): string {
  if (word.length === 0) return word;
  const lower = word.toLowerCase();

  if (UNCOUNTABLE.has(lower)) return word;

  const irregular = IRREGULAR_PLURALS.get(lower);
  if (irregular !== undefined) return matchCase(word, irregular);

  // consonant + 'y' -> 'ies' (baby -> babies); vowel + 'y' -> +s (day -> days)
  if (lower.endsWith('y')) {
    const beforeY = lower.charAt(lower.length - 2);
    if (beforeY !== '' && !VOWELS.has(beforeY)) {
      return word.slice(0, -1) + 'ies';
    }
    return word + 's';
  }

  // sibilant endings take 'es'
  if (
    lower.endsWith('s') ||
    lower.endsWith('x') ||
    lower.endsWith('z') ||
    lower.endsWith('ch') ||
    lower.endsWith('sh')
  ) {
    return word + 'es';
  }

  // 'fe'/'f' -> 'ves' (knife -> knives, wolf -> wolves)
  if (lower.endsWith('fe')) return word.slice(0, -2) + 'ves';
  if (lower.endsWith('f')) return word.slice(0, -1) + 'ves';

  return word + 's';
}

/** Preserve the case of a rule-derived plural against the original word.
 * Only ever called from `pluralize` with a non-empty word. */
function matchCase(original: string, derived: string): string {
  const first = original.charAt(0);
  const isUpper = first !== first.toLowerCase();
  return isUpper ? derived.charAt(0).toUpperCase() + derived.slice(1) : derived;
}

/** Default table name for an entity: the pluralized entity (class) name. */
export function tableNameFor(entityName: string): string {
  return pluralize(entityName);
}

/** Default column name for a property: EF-style, identical to the property. */
export function columnNameFor(propertyName: string): string {
  return propertyName;
}

/** Uppercase the first character (for FK candidate assembly). */
export function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Lowercase the first character (entity name → camelCase FK stem). */
export function camelCase(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toLowerCase() + word.slice(1);
}

/**
 * Is `propertyName` a primary key by convention for `entityName`?
 * Matches `id`, `Id`, `<Entity>Id`, `<Entity>id` — all case-insensitively.
 */
export function isKeyByConvention(propertyName: string, entityName: string): boolean {
  const prop = propertyName.toLowerCase();
  if (prop === 'id') return true;
  const entity = entityName.toLowerCase();
  return prop === entity + 'id';
}

/**
 * Discover the PK property from candidate property names. Returns the matching
 * name, or null if convention finds none.
 */
export function discoverKey(
  entityName: string,
  propertyNames: readonly string[],
): string | null {
  for (const name of propertyNames) {
    if (isKeyByConvention(name, entityName)) return name;
  }
  return null;
}

/**
 * Ordered foreign-key column-name candidates for a reference navigation.
 * Discovery picks the first candidate that exists on the dependent entity.
 */
export function foreignKeyCandidates(
  navigationName: string,
  targetEntityName: string,
  principalKey: string,
): readonly string[] {
  const capKey = capitalize(principalKey);
  const stem = camelCase(targetEntityName);
  return [
    navigationName + capKey,
    navigationName + 'Id',
    stem + capKey,
    stem + 'Id',
  ];
}

/**
 * Discover the FK property on the dependent side from its property names.
 * Returns the first convention candidate present, else null.
 */
export function discoverForeignKey(
  navigationName: string,
  targetEntityName: string,
  principalKey: string,
  dependentPropertyNames: readonly string[],
): string | null {
  const present = new Set(dependentPropertyNames);
  for (const candidate of foreignKeyCandidates(navigationName, targetEntityName, principalKey)) {
    if (present.has(candidate)) return candidate;
  }
  return null;
}

/** Owned-type flattened column name: `<navigation>_<ownedColumn>`. */
export function ownedColumnName(navigationName: string, ownedColumn: string): string {
  return navigationName + '_' + ownedColumn;
}

/**
 * Narrow a property's CLR type from the hints available without reflection:
 * an explicit type wins; otherwise `maxLength` implies string; a literal
 * default is classified; failing all that, `unknown`.
 */
export function inferClrType(hint: {
  readonly explicit?: ClrType | undefined;
  readonly maxLength?: number | undefined;
  readonly defaultValue?: unknown;
}): ClrType {
  if (hint.explicit !== undefined) return hint.explicit;
  if (hint.maxLength !== undefined) return 'string';
  return classifyValue(hint.defaultValue);
}

/** Classify a runtime literal into a CLR type tag. */
export function classifyValue(value: unknown): ClrType {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'object':
      return value instanceof Date ? 'Date' : 'unknown';
    default:
      return 'unknown';
  }
}

/** Convention delete behavior: required FK cascades, optional FK sets null. */
export function defaultDeleteBehavior(fkNullable: boolean): 'cascade' | 'setNull' {
  return fkNullable ? 'setNull' : 'cascade';
}
