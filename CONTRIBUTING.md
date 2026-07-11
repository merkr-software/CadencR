# Contributing to Cadencr

Thanks for your interest in improving Cadencr! This guide covers coding conventions, commit style, and the pull request process.

By participating, you agree to the [Code of Conduct](./.github/CODE_OF_CONDUCT.md). Security issues follow a separate private flow — see [SECURITY.md](./.github/SECURITY.md).

---

## Local Development

Setup (prerequisites, `.env` files, `pnpm dev`) lives in the [README — Run from source](./README.md#run-from-source). Follow that first. The notes below assume your dev environment is running.

## Common Commands

```bash
pnpm dev             # run desktop app + backend service (the usual)
pnpm start           # desktop only (skips the service watcher)
pnpm test            # run all tests (vitest + cargo test)
pnpm run lint        # oxlint + cargo check
pnpm run format      # auto-format (oxfmt + rustfmt)
pnpm run format:check
```

Run a task for a single package:

```bash
pnpm --filter @cadencr/desktop <script>
pnpm --filter @cadencr/service <script>
```

## Rust Build Storage

Cargo targets are intentionally isolated per Git worktree. The main checkout
uses `./target/`; each linked worktree uses its own `<worktree>/target/`.
Repository scripts deliberately do not use `sccache`: it did not produce cache
hits between Cadencr worktrees, while disabling Cargo incremental compilation
and consuming another large machine-wide cache. Cargo's own incremental cache
instead accelerates repeated builds inside each active worktree.

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

The default test profile omits debug information and incremental state to keep
the many integration test binaries small. Development builds keep Cargo
incremental compilation enabled. For a debugger-oriented test run with line
tables, use:

```bash
pnpm rust -- test --profile test-debug -p cadencr-service <test-name>
```

Inspect and clean storage with dry-run-first commands:

```bash
pnpm rust:storage                         # targets and legacy-path check
pnpm rust:clean                           # preview cleaning the current target
pnpm rust:clean -- --release --apply      # remove current release artifacts
pnpm rust:prune                           # preview non-main targets unused for 14 days
pnpm rust:prune -- --older-than 7d --apply
```

`rust:prune` never cleans the main checkout, the current checkout, or symlinked
targets. Deleted artifacts are safe to rebuild, but applying a
cleanup causes the next Rust command in that worktree to perform a cold build.

Troubleshoot the effective configuration with:

```bash
echo "${CARGO_TARGET_DIR:-<unset>}"
cargo metadata --no-deps --format-version 1 | jq -r .target_directory
pnpm rust:storage
```

---

## Project Conventions

The full ruleset for code style, file/function size limits, and architectural boundaries lives in [`.claude/rules/`](./.claude/rules/) and is mirrored into [`AGENTS.md`](./AGENTS.md) / [`CLAUDE.md`](./CLAUDE.md). Read those before opening a PR.

The three rules contributors hit most often:

- Use **pnpm**, not `npm` or `yarn`.
- When the Rust API surface changes, regenerate the frontend API client with `pnpm --filter @cadencr/desktop run generate:api` and commit `packages/desktop/src/api/generated/index.ts`.
- Keep files under **400 lines** and functions under **100 lines**; extract modules before crossing those limits.

---

## Issue and PR Labels

Maintainers keep labels intentionally simple. Contributors do not need to pick every label themselves, but please choose the most specific issue template and fill out the requested fields so maintainers can label quickly.

| Label | Meaning |
|---|---|
| `Feature` | New user-visible capability or improvement |
| `Fix` | Bug fix or regression |
| `Desktop` | Electron/React desktop app |
| `Backend` | Rust service or SDK/backend integration work |
| `provider:claude` | Claude-specific behavior |
| `provider:codex` | Codex-specific behavior |
| `provider:opencode` | OpenCode-specific behavior |
| `Planned` | Accepted and expected to be worked on |
| `Will fix` | Confirmed fix for a bug/regression |
| `Not planned` | Maintainers do not plan to work on this |
| `Duplicated` | Duplicate of another issue or PR |

Provider labels should be used only when the work is truly provider-specific. Generic frontend/backend code should stay provider-neutral.

## Issue Lifecycle

1. Maintainers label the work as `Feature` or `Fix`.
2. Maintainers add `Desktop`, `Backend`, and provider labels when relevant.
3. Accepted work gets `Planned`; confirmed bugs get `Will fix`.
4. Work that will not be pursued gets `Not planned`; duplicates get `Duplicated`.
5. Closing PRs should use GitHub keywords such as `Closes #123` so issues close automatically on merge.

---

## Branching

- **`main`** is the integration branch.
- Work on short-lived feature branches named with a scope prefix and a short slug — for example `feat/desktop-sidebar-redesign`, `fix/session-runtime-status`, `chore/bump-electron`.
- Rebase onto the latest `main` before opening a pull request.

## Commit Convention

Commits follow **[Conventional Commits](https://www.conventionalcommits.org/)**:

```
<type>(<scope>): <short imperative summary>
```

- **Types**: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`, `build`.
- **Scopes** (optional): package or area — `desktop`, `service`, `session`, `providers`, `landing`, `agent`, etc.
- One logical change per commit. Explain **why**, not just **what**, in the body when the diff is non-obvious.
- Husky runs `pnpm turbo run format:check lint ts-check test knip` as a pre-commit hook. Do not bypass it (`--no-verify`) unless a maintainer asks.

Run `git log --oneline` in this repo for a large set of real examples.

## Pull Request Process

1. **Open early.** Draft PRs are welcome for feedback before the work is final.
2. **Use the PR template.** It prompts for summary, motivation, and a test plan.
3. **Keep PRs focused.** A PR should be reviewable in one sitting. Split large changes.
4. **CI must be green** — lint, typecheck, tests, knip, and format checks all pass.
5. **Link the issue.** Use `Closes #123`, `Fixes #123`, or explain why there is no issue.
6. **Show visible changes.** Include screenshots or recordings for UI changes.
7. **Squash on merge.** PRs are squash-merged so `main` stays linear; the squash commit message must itself follow Conventional Commits.

For a bugfix, include a test that fails without the fix. For a feature, include a test that exercises the new behavior end-to-end when practical.

---

## Notes

- `.env` files under `packages/*/` are local-only and must never be committed. They are covered by `.gitignore`.
- Questions? Open a [discussion](https://github.com/merkr-software/cadencr/discussions) or a draft issue.
