/**
 * Value converters (runtime side of `hasConversion`, ADR-006).
 *
 * A property configured with `hasConversion('name')` stores only the *name* in
 * the (serializable) model snapshot — the converter functions never touch the
 * snapshot, so migrations stay byte-stable. The functions live here in a runtime
 * registry keyed by that name and supplied through `DbContextOptions.converters`.
 *
 * Conversion is applied at the read/write boundary:
 *  - **write** — `toProvider` maps a model value to its database representation
 *    for INSERT/UPDATE/DELETE values and key/concurrency predicates;
 *  - **read** — `fromProvider` maps a database value back when materializing;
 *  - **query** — a constant compared against a converted column in `where(...)`
 *    is run through `toProvider` so you filter with model values.
 */

/** A bidirectional value converter between a model value and its provider (DB) value. */
export interface ValueConverter<Model = unknown, Provider = unknown> {
  /** Model value → provider (database) value. Applied on write and in filters. */
  readonly toProvider: (value: Model) => Provider;
  /** Provider (database) value → model value. Applied on read (materialization). */
  readonly fromProvider: (value: Provider) => Model;
}

/** Registered converters, keyed by the name passed to `hasConversion(name)`. */
export type ValueConverterRegistry = ReadonlyMap<string, ValueConverter>;

/**
 * Author a typed converter and erase it to the registry's shape. The generics
 * give full type-checking inside `toProvider`/`fromProvider`; the returned value
 * slots into `DbContextOptions.converters` without leaking those types.
 */
export function defineConverter<Model, Provider>(
  converter: ValueConverter<Model, Provider>,
): ValueConverter {
  return converter as unknown as ValueConverter;
}

/** Object ⇆ JSON text. Handy for `jsonb`-style columns modelled as plain columns. */
export const jsonConverter = defineConverter<unknown, string>({
  toProvider: (value) => JSON.stringify(value),
  fromProvider: (value) => JSON.parse(value) as unknown,
});

/** boolean ⇆ 0/1, for dialects that store flags as integers. */
export const booleanNumberConverter = defineConverter<boolean, number>({
  toProvider: (value) => (value ? 1 : 0),
  fromProvider: (value) => value !== 0,
});

/** Date ⇆ ISO-8601 string. */
export const isoDateConverter = defineConverter<Date, string>({
  toProvider: (value) => value.toISOString(),
  fromProvider: (value) => new Date(value),
});

/**
 * Build a property-name → converter map for one entity, resolving each
 * property's `conversion` name against the registry. Properties whose converter
 * name is not registered are omitted (validated separately at context build).
 */
export function entityConverters(
  properties: readonly { readonly name: string; readonly conversion: string | null }[],
  registry: ValueConverterRegistry | undefined,
): Map<string, ValueConverter> {
  const out = new Map<string, ValueConverter>();
  if (!registry || registry.size === 0) return out;
  for (const p of properties) {
    if (p.conversion) {
      const converter = registry.get(p.conversion);
      if (converter) out.set(p.name, converter);
    }
  }
  return out;
}
