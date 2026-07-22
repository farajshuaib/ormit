---
name: ormit-keep-skills-updated
description: Maintenance rule for this repo's .claude/skills/ reference set. Load this whenever you are about to finish a change to any file under packages/ (core, engine-kysely, dialect-sqlite/postgres/mysql/mssql, plugins, migrations, cli, decorators, adapters, testing) — before ending your turn, check whether the edit made one of the 7 ormit-* skill files stale (wrong file:line refs, changed behavior, a "known gap" that got fixed, a new public API) and update it. Also covers adding a skill file for a brand-new package.
---

# Keeping ormit-* skills in sync with the code

The 7 `ormit-*` skill files exist so future sessions don't have to re-read all
~6,275 lines of `packages/*/src` just to touch one subsystem. That only works if
they stay accurate — a stale skill is worse than no skill, because it gets trusted
and cited instead of the real file. **Any change to `packages/` that alters
behavior, an invariant, a public API, a line-referenced detail, or fixes a
documented gap must be reflected in the matching skill file(s) before the turn ends.**

## Package/subsystem → skill file map

| Touched path | Skill file |
|---|---|
| `packages/core/src/expressions/recorder.ts`, `ir/*`, `pipeline/*`, `context/queryable.ts`, `context/include-loader.ts` | [ormit-query-pipeline](../ormit-query-pipeline/SKILL.md) |
| `packages/core/src/tracking/*`, `context/db-context.ts` (saveChanges/entry/load) | [ormit-change-tracking](../ormit-change-tracking/SKILL.md) |
| `packages/core/src/metadata/*` | [ormit-metadata](../ormit-metadata/SKILL.md) |
| `packages/engine-kysely/src/*`, `packages/dialect-{sqlite,postgres,mysql,mssql}/src/*` | [ormit-engine-kysely](../ormit-engine-kysely/SKILL.md) |
| `packages/migrations/src/*`, `packages/cli/src/*` | [ormit-migrations](../ormit-migrations/SKILL.md) |
| `packages/plugins/src/*`, `packages/core/src/plugins/types.ts` | [ormit-plugins](../ormit-plugins/SKILL.md) |
| `packages/core/src/context/factory.ts`, `context/lazy.ts`, `packages/decorators/src/*`, `packages/adapters/src/*`, `packages/testing/src/*` | [ormit-integration](../ormit-integration/SKILL.md) |

A single change can span more than one row (e.g. a new `WriteOp` kind touches both
`ormit-query-pipeline`'s IR section and `ormit-engine-kysely`'s lowering section) —
update every affected file, not just the first match.

## What to update, and how

1. **Identify what actually changed in substance** — new/removed/renamed exported
   function or type, a changed algorithm or ordering, a new IR node kind, a fixed
   bug that a skill described as a "known gap" (e.g. the `any()/all()/count()`
   correlated-subquery lowering gap noted in `ormit-query-pipeline` and
   `ormit-engine-kysely` — if that ever gets implemented, both files need the gap
   note replaced with a description of the real lowering), a new diagnostic code, a
   new dialect capability, a new plugin.
2. **Skip trivial edits** — pure formatting, comment wording, internal variable
   renames, or test-only changes don't need a skill update.
3. **Edit the skill file with `Edit`, not a rewrite** — change only the stale
   section; keep the existing density and style (dense prose, `[label](path)`
   links, `file.ts:line` refs, one skill file per subsystem, no full source dumps).
4. **Line numbers drift.** If you changed line counts earlier in a file, either
   re-check the new line number or fall back to the file's existing convention of
   approximate refs (`line ~230`) rather than leaving a now-wrong exact number.
5. **New package or subsystem** — create `.claude/skills/<name>/SKILL.md` with the
   same frontmatter shape (`name`, one-line `description` ending in "Use when…"),
   add a row to the map above, and add the package to `CLAUDE.md`'s package map if
   it's a new workspace package.
6. **Cross-check `docs/diagnostics.md`** when adding/removing an `OMT12xx` code —
   `ormit-metadata` says these two must stay in sync; don't let this skill's own
   advice go stale either.

Don't mention this bookkeeping step to the user unless they ask — just do it as
part of finishing the change, the same way you'd update a type signature's callers.
