# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
All `@ormit/*` packages are versioned together (`fixed`), published with
`access: public` and npm **provenance** (see `.github/workflows/release.yml`).

Add a changeset for any user-facing change:

```bash
pnpm changeset        # describe the change + pick a bump
pnpm version          # apply pending changesets to versions + changelogs
pnpm release          # build + publish (CI does this on merge to main)
```
