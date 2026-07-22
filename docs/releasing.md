# Releasing Ormit to npm

This is the step-by-step runbook for publishing `@ormit/*` packages. The
automation already exists (`.github/workflows/release.yml` + `ci.yml`) — this
doc is about what *you* need to do to actually trigger it, especially for the
first release.

## How the pipeline works

- **Every push/PR** — `ci.yml`'s `gate` job runs the offline gate (build,
  dependency rules, type tests, 100%-branch coverage). Nightly + on-demand, a
  `compatibility` job runs the real-database suite (Postgres/MySQL/SQL Server
  via Testcontainers) and the throughput benchmark gate.
- **Push to `main`** — `release.yml`'s `version` job runs `changesets/action`,
  which opens or updates a **"Version Packages" PR** *if* there are pending
  changeset files in `.changeset/`. It never publishes anything by itself.
- **Publishing is always manual** — trigger the `Release` workflow by hand
  (`workflow_dispatch`) from the Actions tab. That runs `pnpm release`
  (`pnpm build && changeset publish`), which publishes any package whose
  current version isn't already on the npm registry, with provenance.

This two-step design (auto version PR, manual publish) is deliberate — see the
comments in `release.yml`. Nothing publishes just because you pushed to `main`.

## Part A — One-time setup (only you can do this)

1. **npm account** — make sure you have one at npmjs.com.
2. **Create the `ormit` npm organization** (npmjs.com → Add Organization). This
   is what lets anything publish under the `@ormit/*` scope — the free tier
   covers public packages. Checked against the registry just now: the `@ormit`
   scope and the unscoped `ormit` name are both still unclaimed.
3. **Generate an npm access token** — an "Automation" or "Granular Access"
   token (not your personal password) scoped to publish access for the
   `ormit` org. Automation tokens bypass 2FA prompts, which CI needs.
4. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `NPM_TOKEN` — the token from step 3. Used as `NODE_AUTH_TOKEN` by the
     `publish` job.
   - `GH_TOKEN` — a GitHub personal access token with `repo` scope. The
     `version` job uses this explicitly (not the default `GITHUB_TOKEN`) so
     `changesets/action` can open PRs and push branches without hitting
     default-token workflow restrictions.
5. **Confirm the repository is public** — required for free GitHub Pages
   (already wired up in `pages.yml`) and matches an open-source npm package.

Nothing else to configure for provenance — it's automatic given
`id-token: write` permission (already set in `release.yml`) plus
`NPM_CONFIG_PROVENANCE: true`, as long as the publish happens from GitHub
Actions rather than someone's laptop.

## Part B — Repo readiness (verified, already green)

- `pnpm gate:rc` passes clean: build, dependency rules, type tests, 100%
  branch coverage on `conventions.ts`, and the compile-perf gate.
- All 12 packages have consistent `name`, `version` (currently `0.0.1`),
  `license` (MIT), `files: ["dist"]`, `repository`, and `exports`.
- Root `LICENSE` file exists (MIT).
- `.changeset/config.json` is already configured: `access: "public"`,
  `@ormit/*` versions kept in lockstep (`fixed`), changelog generation on.
- No pending changeset files exist yet — see Part C for why that's fine for a
  first release.

## Part C — Decide your starting version

Every package is currently `0.0.1`. Before publishing, pick one:

- **Ship `0.0.1` as-is.** Nothing to do — `changeset publish` will publish
  whatever's in each `package.json` right now, since nothing is on the
  registry yet.
- **Bump first** (e.g. to `0.1.0`) via a changeset: run `pnpm changeset`
  locally, pick the packages and bump type, commit the generated
  `.changeset/*.md` file, and merge it to `main` before publishing. The
  `version` job will then open a Version Packages PR that bumps every
  `package.json` and writes a CHANGELOG entry.

`docs/implementation-plan.md`'s own 1.0-rc checklist implies this project
isn't claiming 1.0 yet, so `0.1.0` is the more conventional "first public
release" number — but `0.0.1` is a legitimate choice too. Your call.

## Part D — The actual release

1. *(Only if bumping versions)* Merge a PR containing your `pnpm changeset`
   output to `main`.
2. Push to `main` (directly, or via the PR merge above). The `version` job
   runs automatically. If there were pending changesets, it opens/updates a
   **Version Packages** PR — review and merge it. If you're shipping `0.0.1`
   as-is, there's nothing to version and no PR appears; skip to step 3.
3. GitHub → **Actions → Release → Run workflow**, on `main`. This runs the
   `publish` job for real: builds everything, then `changeset publish`, which
   skips any package version already on the registry and publishes the rest.
4. Watch the run to completion. The most common failure causes: the `ormit`
   org doesn't exist yet, `NPM_TOKEN` is missing/expired, or the token needs
   2FA (use an Automation token to avoid this).

## Part E — Verify after publishing

- `npm view @ormit/core` (and a couple of others) to confirm they're live.
- Check npmjs.com shows each package as "Built and signed on GitHub Actions"
  (the provenance badge).
- In a scratch folder *outside* this repo: `pnpm add @ormit/core @ormit/sqlite`
  and run a tiny script against them. This is the one thing local testing
  can't catch — inside the monorepo everything resolves through pnpm
  workspace symlinks, never through the real published tarball.

## After the first release

Every subsequent release is just: merge PRs that each include a changeset
(`pnpm changeset` before opening the PR) → merge the auto-opened Version
Packages PR when you're ready to cut a release → manually trigger the
`Release` workflow. Nothing else changes.
