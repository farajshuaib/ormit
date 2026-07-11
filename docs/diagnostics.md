# Ormit diagnostics

Every model-validation problem carries a stable `OMT` code. Validation runs
eagerly when the model is finalized (`ModelSnapshot.build`, invoked once per
`DbContext` class), collects **all** problems in a single pass, and throws a
`ModelValidationError` whose `diagnostics` array lists them (its `code` is the
first). Codes are part of the public contract and never change meaning.

## Model validation (`OMT12xx`)

| Code | Title | Cause & fix |
|---|---|---|
| `OMT1201` | Entity has no primary key | No `hasKey()` and no `id` / `<entity>Id` property to discover. Call `hasKey(...)` or add a conventional key property. |
| `OMT1202` | Key property collides with a navigation name | A property named in `hasKey()` is also a navigation. Rename one; keys must be scalar. |
| `OMT1203` | Entity registered more than once | `entity(Ctor, …)` was called twice for the same class. Configure each entity once. |
| `OMT1204` | Two entities mapped to the same table | Distinct entities resolved to one table without a discriminator. Use distinct tables, or configure TPH with `hasDiscriminator`. |
| `OMT1205` | Duplicate column name within an entity | Two properties map to the same column. Give them distinct `hasColumnName(...)`. |
| `OMT1206` | `hasMaxLength` must be a positive integer | A non-positive or non-integer length was supplied. |
| `OMT1207` | Foreign key arity does not match the principal key | `hasForeignKey(...)` lists a different number of columns than the principal key. Match the arity. |
| `OMT1208` | Foreign key could not be resolved | The relationship's principal entity has no primary key, so no FK can reference it. Give the principal a key. |
| `OMT1209` | Discriminator value is not unique | Two entities sharing a table declare the same discriminator value. Make each value unique. |
| `OMT1210` | Composite key lists a property twice | `hasKey('a', 'a')`. List each key property once. |
| `OMT1211` | Seed row is missing a key value | A `hasData` row omits a key property. Every seed row must specify the full key. |
| `OMT1212` | Seed row references an unknown property | A `hasData` row has a column that is not a configured property. Configure it with `property(...)`. |
| `OMT1213` | Index references an unknown property | `hasIndex('x')` where `x` is not a configured property. |
| `OMT1214` | Index declares no properties | `hasIndex()` was called with no properties. |
| `OMT1215` | `hasConversion` requires a converter name | An empty converter name was supplied. |
| `OMT1216` | Owned type may not declare its own key | An owned type called `hasKey(...)`; owned types share the owner's identity. |
| `OMT1217` | `hasColumnName` requires a non-empty name | An empty column name was supplied. |
| `OMT1218` | A key property cannot be a concurrency token | `isConcurrencyToken()` was set on a key property. Use a non-key column (e.g. a `rowversion`). |
| `OMT1219` | `toTable` requires a non-empty name | An empty table name was supplied. |
| `OMT1220` | Many-to-many join entity is not in the model | `usingEntity(Join)` where `Join` was never registered with `entity(...)`. |
| `OMT1221` | Navigation name collides with a scalar property | A navigation and a scalar property share a name. Rename one. |
| `OMT1222` | Discriminator declared without a value | `hasDiscriminator(column)` without a following `hasValue(...)`. |
| `OMT1223` | `hasDefault` and `hasDefaultSql` are mutually exclusive | A property set both a literal default and a SQL default. Pick one. |

## Query translation (`OMT10xx`)

| Code | Title |
|---|---|
| `OMT1001` | Expression could not be translated |
| `OMT1002` | Entity not found |
| `OMT1003` | Concurrency conflict |
