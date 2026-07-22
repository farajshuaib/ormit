---
name: ormit-keep-docs-updated
description: Documentation maintenance rule for this repo. Load this whenever you are about to finish a change to any file under packages/ that affects public API surface, behavior, diagnostics codes, supported dialects/plugins, or architecture — before ending your turn, check whether README.md, docs/guide.md, docs/orm-architecture.md, docs/implementation-plan.md, docs/diagnostics.md, or a docs/adr/*.md stub is now stale, and update it.
---

# Keeping the docs in sync with the code

This repo's docs are user-facing and design-authoritative, not auto-generated —
nothing regenerates them from source. **A change that alters public behavior,
adds/removes a diagnostic code, adds a dialect or plugin, or changes an
architectural decision must be reflected in the matching doc(s) before the turn
ends**, the same way [ormit-keep-skills-updated](../ormit-keep-skills-updated/SKILL.md)
keeps the `.claude/skills/` reference set in sync. Skip purely internal refactors,
test-only changes, and typo/formatting fixes.

## What lives where

- **[README.md](../../../README.md)** and **[docs/guide.md](../../../docs/guide.md)**
  overlap heavily and duplicate the same worked examples (Quickstart, Querying,
  Saving, Value converters, Relationships, Plugins, Migrations, CLI, Dialects/
  "Choosing a database", Web adapters, Testing, "Coming from EF Core"). **A public
  API change almost always needs both files updated**, not just one — check the
  matching `##`/`###` heading in each before assuming one is enough.
- **[docs/diagnostics.md](../../../docs/diagnostics.md)** is the human-readable
  mirror of `OMT12xx` codes in
  [metadata/diagnostics.ts](../../../packages/core/src/metadata/diagnostics.ts)
  (`DIAGNOSTIC_TITLES`) — adding/removing/renaming a code must update both (see
  [ormit-metadata](../ormit-metadata/SKILL.md), which owns the source side).
- **[docs/orm-architecture.md](../../../docs/orm-architecture.md)** is the full
  narrative design doc (public API design, internal architecture, query subsystem,
  metadata, change tracking, relationships, transactions, migrations, DI,
  cross-cutting/plugins, roadmap) **and** carries its own copy of the ADR text in
  its Appendix A (~line 449).
- **[docs/implementation-plan.md](../../../docs/implementation-plan.md)** is the
  doc CLAUDE.md calls "authoritative." §3 (Public API Contract) and §4 (Internal
  Contracts) are explicitly marked **`[FROZEN]`** (~lines 54, 129) — a change there
  isn't a routine doc-sync, it's a change to a frozen contract. If your code change
  actually breaks one of these, **flag it to the user explicitly** rather than
  quietly editing the FROZEN section to match; don't paper over a contract break
  with a doc update. Its own Appendix A (~line 273) is a second copy of the ADR
  index. §6 (Work Breakdown & Milestones, phases M0–M5) is a historical roadmap —
  don't edit completed-phase descriptions for routine changes.
- **[docs/adr/*.md](../../../docs/adr/)** — each file is a **3-line stub**
  (`# ADR-NNN: title` / `Status: ...` / "Full text: see implementation plan /
  architecture document."). The real decision text lives in the two Appendix A
  copies above. A new architectural decision needs **all three** kept consistent:
  a new stub file, a new entry in `implementation-plan.md`'s ADR index, and a new
  entry in `orm-architecture.md`'s Appendix A — plus bump the doc cross-reference
  in [CLAUDE.md](../../../CLAUDE.md) if the ADR list there is mentioned by number.

## Trigger checklist by change type

| You changed... | Update... |
|---|---|
| A `Queryable`/`DbSet`/`DbContext` public method, `ModelBuilder`/`EntityBuilder` fluent API, or example-worthy behavior | README.md **and** docs/guide.md matching section |
| An `OMT12xx` diagnostic code | docs/diagnostics.md |
| A new dialect package or a `DialectCapabilities` field | README.md "Dialects", docs/guide.md "Choosing a database" |
| A new/changed first-party plugin | README.md "Plugins", docs/guide.md "Plugins" |
| A new workspace package | docs/implementation-plan.md §2 Package Layout, CLAUDE.md's package map (see ormit-keep-skills-updated) |
| A genuinely new architectural decision | new docs/adr/NNN-*.md stub + both Appendix A copies |
| §3/§4 of implementation-plan.md would need to change | **stop and tell the user** — this is a frozen-contract break, not a doc edit |

Don't narrate this bookkeeping to the user unless asked — treat it as part of
finishing the change, same as updating a caller after a signature change.
