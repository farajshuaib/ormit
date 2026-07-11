# Security Policy

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a
public issue. We aim to acknowledge reports within 72 hours.

## Design posture

- **Parameterized by construction.** All user values — including `fromSql`
  tagged-template interpolations — are bound parameters, never concatenated into
  SQL text. Identifiers are quoted by the dialect compiler. A fuzz suite
  (`packages/dialect-sqlite/test/security.property.test.ts`) asserts that
  classic injection payloads round-trip as inert literals and cannot alter the
  schema.
- **No client-side query evaluation** and **no `fn.toString()` parsing**: the
  expression recorder captures a closed IR via a typed Proxy (ADR-001), so
  minification and untrusted code cannot smuggle behavior into a query.
- **Least-privilege migrations.** DDL is generated from committed model
  snapshots (never live-DB introspection, ADR-006) and applied through a
  transactional runner with a history table.
