# Contributing to Cadencr

Thanks for your interest in improving Cadencr! This guide covers coding conventions, commit style, and the pull request process.

By participating, you agree to the [Code of Conduct](./.github/CODE_OF_CONDUCT.md). Security issues follow a separate private flow — see [SECURITY.md](./.github/SECURITY.md).

---

## Local Development

Setup (prerequisites, `pnpm setup:dev`, `pnpm doctor`, worktrees) lives in the [README — Run from source](./README.md#run-from-source). Follow that first. The notes below assume your dev environment is running; when it is not, `pnpm doctor` names the problem and its fix.

## Common Commands

The shared [command reference](./AGENTS.md#commands) lists development, build,
test, lint, format, and diagnostic commands. Use package-scoped checks while
iterating; the examples below supplement that reference.

Run only the desktop tests that cover the files you touched (paths relative to
`packages/desktop`):

```bash
pnpm --filter @cadencr/desktop exec vitest related --run src/lib/foo.ts
```

Run a task for a single package:

```bash
pnpm --filter @cadencr/desktop <script>
pnpm --filter @cadencr/service <script>
```

### Packaged local builds

Run:

```bash
pnpm build:local                 # macOS local package
pnpm build:local:linux           # Linux local packages
pnpm build:local --check-config  # validate configuration without compiling
```

These commands fetch the public marketplace, registry and Sentry/PostHog build
variables from `merkr-software/CadencR`, validate them, then compile on your
machine. Install GitHub CLI and authenticate with `gh auth login` to fetch the
configuration and enable these features.
If `gh` is absent, GitHub is unreachable, access is denied, or no build variables
are configured, the build continues with the managed marketplace and all telemetry
disabled. The command prints this fallback explicitly and removes inherited build
variables so stale shell exports cannot reactivate those features. A successfully
fetched but partial or malformed configuration still stops compilation.
Values are passed directly to child processes without shell evaluation or
writing a `.env` file. GitHub values replace inherited exports for these build
variables, including removing exports that no longer exist in GitHub.

All three telemetry variables (`CADENCR_SENTRY_DSN`, `CADENCR_POSTHOG_KEY`,
`CADENCR_POSTHOG_HOST`) must be present in a configured build. They are embedded
in the Rust service so the installed app can send telemetry according to the
user's preferences.
These commands do not upload Sentry source maps; see
[Telemetry](./docs/TELEMETRY.md#renderer-source-maps-and-release-correlation).

## Rust Build Storage

Cargo targets are intentionally isolated per Git worktree. The main checkout
uses `./target/`; each linked worktree uses its own `<worktree>/target/`.
Repository scripts deliberately do not use `sccache`: it did not produce cache
hits between Cadencr worktrees and consumed another large machine-wide cache.
Incremental compilation is also disabled in the development and test profiles
to save disk space. The Cargo wrapper enforces `CARGO_INCREMENTAL=0`, including
when an inherited environment variable would otherwise enable it. Rebuilds
after source changes may take longer.

Do not set `CARGO_TARGET_DIR` to `.shared-cargo-target` or another shared path.
Sharing Cargo targets can mix branch artifacts, create lock contention, and
leave large directories behind after worktrees are removed. The repository's
Cargo wrapper overrides inherited `CARGO_TARGET_DIR` values to enforce the
per-worktree policy.

Use the wrapper for targeted Cargo commands:

```bash
pnpm rust -- test -p cadencr-service shared::migrate
pnpm rust -- check -p opencode-sdk-rs
```

The default development and test profiles also omit debug information to keep
every worktree's Cargo target small. Existing incremental caches are not removed
automatically; `pnpm rust:clean` / `pnpm rust:prune` below can reclaim old build
artifacts. Omitting debug information does not disable application logs. For a
debugger-oriented test run with line tables, use:

```bash
pnpm rust -- test --profile test-debug -p cadencr-service <test-name>
```

Precompile the Rust targets used by `pnpm dev` without starting the app:

```bash
pnpm dev:precompile
```

For Cadencr-managed worktrees, set the project's worktree setup commands to
`pnpm install && pnpm dev:configure-worktree && pnpm dev:precompile`. The setup
runs in the new worktree, so it gets its own `.env` ports and a warm local
`target/` before the first `pnpm dev`.

Inspect and clean storage with dry-run-first commands:

```bash
pnpm rust:storage                         # targets, dev databases and backups
pnpm rust:clean                           # preview cleaning the current target
pnpm rust:clean -- --release --apply      # remove current release artifacts
pnpm rust:prune                           # preview non-main targets unused for 14 days
pnpm rust:prune -- --older-than 7d --apply
```

`rust:prune` never cleans the main checkout, the current checkout, or symlinked
targets. Deleted artifacts are safe to rebuild, but applying a
cleanup causes the next Rust command in that worktree to perform a cold build.

### Dev databases

Dev databases are usually bigger than the Cargo targets, so worktrees keep
them cheap:

- `pnpm dev:configure-worktree` seeds a worktree's database as a copy-on-write
  clone of the main checkout's (`cp -c` on APFS, reflink elsewhere). The clone
  shares its blocks until either side writes, so a multi-GB database costs
  almost nothing per worktree. Worktrees created before this change hold full
  copies.
- Only when that run clones the database, and the worktree's `CADENCR_DB_PATH`
  points at the clone, does it write a `cadencr.local.db.fresh-clone` marker
  next to it. The first start of a debug build then skips the pre-migration
  `VACUUM INTO` snapshot, which would be a full, unshared copy of data the main
  checkout still holds, and deletes the marker: from then on the worktree may
  hold data of its own, so every later migration backs up as usual. A database
  the worktree already had (rerunning the script never replaces it), a custom
  `CADENCR_DB_PATH` that may name a shared database, the main checkout and
  release builds always back up before migrating.

`pnpm rust:storage` lists every dev database and the installed app's
`~/.cadencr/database`, and names the backups the service never rotates (legacy
`<version>.<hour>` snapshots without a source identity, hand-made `.bck`
copies). Nothing deletes those automatically: check you no longer need them,
then remove them yourself.

Troubleshoot the effective configuration with:

```bash
echo "${CARGO_TARGET_DIR:-<unset>}"
pnpm rust -- metadata --no-deps --format-version 1 | jq -r .target_directory
pnpm rust:storage
```

---

## Project Conventions

[`AGENTS.md`](./AGENTS.md) is the short agent entry point: essential constraints, commands, validation, and an index of applicable rules. Detailed rules have one source in [`.claude/rules/`](./.claude/rules/). This guide covers contributor setup and Git/release workflows; it is read when needed, not imported into every agent session.

### Agent instruction setup

| Agent       | Repository instructions                                                                                         | Shared skills                                |
| ----------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Cursor      | Root/scoped `AGENTS.md` indexes; read the linked rules for the task                                             | `.agents/skills/`                            |
| Claude Code | `CLAUDE.md` imports `AGENTS.md`; unscoped rules load at startup, path-scoped rules when matching files are used | `.claude/skills/` links to `.agents/skills/` |
| Codex       | `AGENTS.md` from root to working directory; read the linked rules and deeper instructions for edited files      | `.agents/skills/`                            |

Edit shared guidance in `AGENTS.md`, rules in `.claude/rules/`, and skills in `.agents/skills/`. Keep `CLAUDE.md` as the single `@AGENTS.md` import. `pnpm build:agents-md` generates source links and scopes, not copies of rule bodies: Claude's native loader and agents reading a source see the same text. Already-loaded rules need not be read again. The two critical database/rollback constraints are intentionally summarized at the entry point; other detailed policies belong in their rule files. Preserve the Turbo-managed block outside the generated index.

After editing rules, run `pnpm build:agents-md`, then `pnpm build:agents-md --check`; pre-commit and CI check the indexes too. Start a new session after instruction changes. In Claude Code, `/context` shows loaded memory files. For Cursor/Codex, check that the agent opens the applicable rule sources before edits; links are discovery instructions, not automatic imports. The default Codex instruction budget is 32 KiB, which is a ceiling, not a target.

Loading conventions: [Cursor rules](https://cursor.com/docs/rules), [Cursor skills](https://cursor.com/docs/skills), [Claude Code imports](https://code.claude.com/docs/en/memory#import-additional-files), and [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

Keep persistent instructions short, concrete, and based on observed mistakes. Put occasional procedures in skills or linked docs; do not repeat linter rules or maintain parallel `.cursor/rules/` copies. See [Claude Code best practices](https://code.claude.com/docs/en/best-practices#write-an-effective-claudemd), [Cursor rule guidance](https://cursor.com/docs/rules#best-practices), and [Codex best practices](https://learn.chatgpt.com/guides/best-practices#make-guidance-reusable-with-agentsmd). These are context-management recommendations, not a measured guarantee that a particular model will perform better.

---

## Issue and PR Labels

Maintainers keep labels intentionally simple. Contributors do not need to pick every label themselves, but please choose the most specific issue template and fill out the requested fields so maintainers can label quickly.

| Label               | Meaning                                      |
| ------------------- | -------------------------------------------- |
| `Feature`           | New user-visible capability or improvement   |
| `Fix`               | Bug fix or regression                        |
| `Desktop`           | Electron/React desktop app                   |
| `Backend`           | Rust service or SDK/backend integration work |
| `provider:claude`   | Claude-specific behavior                     |
| `provider:codex`    | Codex-specific behavior                      |
| `provider:opencode` | OpenCode-specific behavior                   |
| `Planned`           | Accepted and expected to be worked on        |
| `Will fix`          | Confirmed fix for a bug/regression           |
| `Not planned`       | Maintainers do not plan to work on this      |
| `Duplicated`        | Duplicate of another issue or PR             |

Provider labels should be used only when the work is truly provider-specific. Generic frontend/backend code should stay provider-neutral.

## Issue Lifecycle

1. Maintainers label the work as `Feature` or `Fix`.
2. Maintainers add `Desktop`, `Backend`, and provider labels when relevant.
3. Accepted work gets `Planned`; confirmed bugs get `Will fix`.
4. Work that will not be pursued gets `Not planned`; duplicates get `Duplicated`.
5. Closing PRs should use GitHub keywords such as `Closes #123` so issues close automatically on merge.

---

## Branching

Cadencr keeps `main` long-lived and creates a version-named integration branch for each
feature release:

| Branch                                | Meaning                                                | What lands here                                                      |
| ------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| **`vX.Y.Z`** (for example, `v0.10.0`) | Temporary integration branch for that release.         | Feature branches, dependency bumps, follow-up polish                 |
| **`main`**                            | Releasable. Every commit is a valid release candidate. | Promotions from a version branch, urgent fixes, release-prep commits |

Release tags (`vX.Y.Z`) are always cut from `main`. Pushing a tag triggers
[`desktop-release.yml`](./.github/workflows/desktop-release.yml), which notarizes the app, publishes the
GitHub release, and updates the Homebrew cask — so a tag reaches users immediately and its version number
is spent for good. Linux ships as an alpha, by hand: once the release is published,
[`desktop-linux-release.yml`](./.github/workflows/desktop-linux-release.yml) builds the same tag for Linux
and attaches the packages to it (`gh workflow run desktop-linux-release.yml -f release_tag=vX.Y.Z`).

**Why a version branch.** A feature is usually merged before it is polished. When the integration branch
is also the release source, that half-finished feature blocks every unrelated fix from shipping until the
polish is done. Keeping unpolished work on a branch named for its intended release means `main` can be
tagged at any moment, while the branch name makes the target milestone explicit.

```mermaid
gitGraph
   commit id: "v0.9.0" tag: "v0.9.0"
   branch v0.10.0
   checkout v0.10.0
   commit id: "feat: schedules"
   commit id: "polish: schedules"
   checkout main
   commit id: "fix: codex crash"
   commit id: "chore: prepare v0.9.1" tag: "v0.9.1"
   checkout v0.10.0
   merge main
   commit id: "polish: schedules again"
   checkout main
   merge v0.10.0
   commit id: "chore: prepare v0.10.0" tag: "v0.10.0"
```

### Day-to-day work

1. Find the active version branch for the upcoming feature release — for example, `v0.10.0`.
2. Branch from that version branch, not `main`. Use short-lived branches named with a scope prefix and a
   short slug — for example `feat/desktop-sidebar-redesign`, `fix/session-runtime-status`,
   `chore/bump-electron`.
3. Rebase onto the latest version branch before opening a pull request, and target that branch with the PR.
4. Polish, follow-up fixes, and review feedback for that feature also go to the same version branch.
5. When the feature is genuinely done — tested in the running app, no known rough edges — a maintainer
   promotes the version branch into `main`.

```bash
git switch v0.10.0 && git pull
git switch -c feat/my-thing
# …work, then open a PR against v0.10.0…
```

### Promoting to `main`

Promotion is a maintainer action and always a merge commit, so a release range maps cleanly onto the set
of promotions it contains:

```bash
git switch main && git pull
git merge --no-ff v0.10.0
git push origin main
```

Promote whole, finished work only. If the version branch contains one polished feature and one still in progress,
wait — or land the finished part on `main` directly as its own branch off `main`.

### Urgent fixes while a version branch is mid-polish

This is the case the flow exists for. Branch off `main`, merge back into `main`, release, then **merge
`main` down into the active version branch in the same session**:

```bash
git switch main && git pull
git switch -c fix/urgent-thing
# …fix, test…
git switch main && git merge --no-ff fix/urgent-thing && git push origin main
git switch v0.10.0 && git merge main && git push origin v0.10.0   # never skip this
```

**The one rule that keeps this cheap:** `main` must never stay ahead of the active version branch. Every
commit that lands on `main` — a fix, a release-prep commit, a hotfix tag — gets merged down into that
version branch right away. Skip it once and the next promotion turns into conflict archaeology.

### Releasing

Releases run from `main` via the `release` skill (`.claude/skills/release/SKILL.md`), which writes the
changelog, bumps versions, runs a security review, verifies `origin/main` is green, and tags. For a feature
release:

1. Promote the `vX.Y.Z` branch into `main`.
2. Delete the version branch locally and remotely.
3. Run the release skill from `main` to create the `vX.Y.Z` tag.
4. Create the next version branch from the released `main` when feature development resumes.

The branch and release tag intentionally use the same name, so the branch must be deleted **before**
tagging; otherwise Git commands can become ambiguous between `refs/heads/vX.Y.Z` and
`refs/tags/vX.Y.Z`.

### Releasing the SDKs and the CLI

The SDKs and the `cadencr` CLI have their own semver, independent of the app: an app release never sets
them to the app version, and they need not ship with one. To release one, bump its version in a normal
PR, let it land on `main` with green CI, then dispatch its workflow from `main`. Each workflow:

- is a dry run unless you untick `dry_run`;
- publishes from a protected environment with required reviewers;
- refuses a version that already exists.

The release skill does all of it. `release --tools [tool …]` releases only the tools. `release vX.Y.Z` also
detects which tools changed since their last release, and offers to release them after the app.
`node scripts/release-tools.mjs` shows that state on its own.

| Artifact                                                 | Version lives in                                                        | Workflow                                       | Tag                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| Desktop app                                              | the app manifests (bumped by the release skill)                         | `desktop-release.yml`, on pushing a `v*` tag   | `vX.Y.Z`               |
| crates.io: `cadencr-tab-backend`, `cadencr-provider-sdk` | the crate's `Cargo.toml`                                                | `crates-release.yml` (environment `crates-io`) | `<crate>-v<version>`   |
| npm: `@cadencr/tab-sdk`, `@cadencr/tab-kit`              | the package's `package.json` (tab-sdk: also `SDK_VERSION`)              | `npm-release.yml` (environment `npm`)          | `<package>-v<version>` |
| CLI `cadencr` (Linux x86_64 binary + `SHA256SUMS`)       | `packages/cli/Cargo.toml`, `packages/cli/package.json` and `Cargo.lock` | `cli-release.yml` (environment `cli-release`)  | `cli/v<version>`       |

`cli-release.yml` takes the reviewed `main`-tip SHA as input, like the development CLI workflow
(`cli-dev-release.yml`, tags `cli/vX.Y.Z-dev.<run>.<attempt>`). Its GitHub release is never marked
"Latest", so the desktop auto-updater and the landing download page keep resolving the app's release. App
releases up to `v0.14.0` also carried the CLI; their assets stay where they are.

## Commit Convention

Commits follow **[Conventional Commits](https://www.conventionalcommits.org/)**:

```
<type>(<scope>): <short imperative summary>
```

- **Types**: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`, `build`.
- **Scopes** (optional): package or area — `desktop`, `service`, `session`, `providers`, `landing`, `agent`, etc.
- One logical change per commit. Explain **why**, not just **what**, in the body when the diff is non-obvious.
- Husky runs a scoped pre-commit check (see [Pre-commit checks](#pre-commit-checks)). Do not bypass it (`--no-verify`) unless a maintainer asks.

Run `git log --oneline` in this repo for a large set of real examples.

## Pre-commit checks

`.husky/pre-commit` runs `node scripts/pre-commit.mjs`, which reads the staged
file list and runs only the checks those files can affect, streaming their
output and stopping at the first failure with the exact command to rerun:

| Staged files                                                                                                                                                          | Checks                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| anything                                                                                                                                                              | `AGENTS.md` is in sync with `.claude/rules/`                                             |
| docs only (`*.md` outside a package's `src/`, `docs/**`)                                                                                                              | nothing else                                                                             |
| any other file                                                                                                                                                        | root script tests (`pnpm run test:scripts`, a few seconds)                               |
| `packages/desktop`, `packages/landing`, `packages/brand`                                                                                                              | that package's `format:check`, `lint`, `ts-check`, `knip` through Turbo, and its tests   |
| desktop sources                                                                                                                                                       | `vitest related --run` on the staged desktop files only                                  |
| desktop `vitest.config.*`, `src/test-setup*`, `src/test/**`, `package.json`                                                                                           | the full desktop suite                                                                   |
| desktop `src/lib/shortcuts/**`, `src/shared/**`                                                                                                                       | landing checks too (it imports the shortcut registry)                                    |
| `packages/brand/src/**`                                                                                                                                               | desktop and landing checks too, tracing desktop tests that import the brand file         |
| `packages/service/src`, `packages/desktop/src`                                                                                                                        | provider-boundary scan                                                                   |
| Rust: `packages/service`, any `packages/*-rs`, `packages/cli-discovery`, `Cargo.toml`/`Cargo.lock`, `rust-toolchain.toml`                                             | `@cadencr/service` `format:check`, `lint` (clippy), `test` for the whole Cargo workspace |
| release scripts, `homebrew/**`, `desktop-release.yml`, `desktop-linux-release.yml`                                                                                    | `pnpm run test:release-scripts`                                                          |
| root tooling: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `.npmrc`, `.nvmrc`, `.husky/**`, `patches/**` | everything                                                                               |

Preview the plan without running it, or force the full workspace check (also
what CI runs):

```bash
node scripts/pre-commit.mjs --dry-run
CADENCR_PRECOMMIT_FULL=1 git commit
```

Checks run against your working tree, so unstaged edits in the same files are
checked too. CI always runs everything, so a scoped pass locally is not a
guarantee.

## Pull Request Process

1. **Target the active version branch.** Contributor PRs are opened against the upcoming release branch
   (for example, `v0.10.0`), never against `main` — see [Branching](#branching). Only maintainers push to
   `main`, for promotions, urgent fixes, and release prep.
2. **Open early.** Draft PRs are welcome for feedback before the work is final.
3. **Use the PR template.** It prompts for summary, motivation, and a test plan.
4. **Keep PRs focused.** A PR should be reviewable in one sitting. Split large changes.
5. **CI must be green** — lint, typecheck, tests, knip, and format checks all pass. `ci.yml` runs them as
   parallel `rust`, `web`, `vitest` (sharded) and `scripts` jobs; the required `Pre-commit checks` status
   passes only when all of them do.
6. **Link the issue.** Use `Closes #123`, `Fixes #123`, or explain why there is no issue.
7. **Show visible changes.** Include screenshots or recordings for UI changes.
8. **Merge with `--no-ff`.** Branches land as a merge commit (`git merge --no-ff`), never squashed or
   fast-forwarded, so the history keeps each reviewed commit and the merge commit groups them. Every
   commit on the branch must therefore follow Conventional Commits on its own. Rebase onto the target
   branch first (step 3 of [Day-to-day work](#day-to-day-work)) so the merge carries no conflict
   resolution. Promotions from a version branch to `main` work the same way.

For a bugfix, include a test that fails without the fix. For a feature, include a test that exercises the new behavior end-to-end when practical.

---

## Notes

- `.env` files under `packages/*/` are local-only and must never be committed. They are covered by `.gitignore`.
- Questions? Open a [discussion](https://github.com/merkr-software/cadencr/discussions) or a draft issue.
