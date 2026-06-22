---
name: release
description: Prepare and publish a Cadencr release from a version tag such as v0.2.0.
argument-hint: vX.Y.Z
user-invocable: true
allowed-tools: Bash(git *) Bash(gh *) Bash(pnpm *) Bash(cargo *) Bash(./scripts/release.sh *) Bash(scripts/release.sh *) Read Grep Glob Edit Write Agent
---

# Release Command

Prepare and publish a Cadencr release.

Arguments: `$ARGUMENTS` must be exactly one semantic version tag in the form `vX.Y.Z`, for example `v0.2.0`.

## Critical safety rule

After `git push origin vX.Y.Z`, the GitHub release workflow starts and the version is considered consumed. If the tag or release must be deleted afterward, do **not** reuse the same version. Increment the version counters and release a new tag.

The helper script creates the local tag only. The agent must push the tag explicitly after all checks pass.

## Required flow

1. **Validate the requested tag**
   - Reject missing or malformed arguments.
   - Use `TAG="$ARGUMENTS"` and `VERSION="${TAG#v}"`.

2. **Inspect the release range**
   - Fetch tags: `git fetch --tags origin`.
   - Find the latest previous release tag: `git tag --list 'v[0-9]*' --sort=-v:refname | head -1`.
   - Summarize commits with `git log --oneline "$PREVIOUS_TAG..HEAD"`.
   - You may inspect the previous tag commit hash internally when useful for validation, but do not include it in published release notes or the final user-facing summary.

3. **Generate release notes and changelog**
   - Update `CHANGELOG.md` with a section for the requested tag.
   - Include the previous tag version and release date; do not include the previous tag commit hash.
   - Write the changelog around user impact: what changed for users, what got better, and what was fixed.
   - Use emoji-prefixed changelog section headings for standard groups, such as `### ✨ Added`, `### 🔧 Changed`, and `### 🐛 Fixed`.
   - Inspect the relevant commit diffs, linked GitHub issues, and linked PRs before wording each changelog line; avoid vague summaries that hide the actual user-facing issue.
   - Use one changelog bullet per new user-facing feature, even if that feature was merged, fixed, polished, or refactored multiple times before the release. Fold those pre-release fixes into the single feature bullet instead of listing them again as separate `Fixed` bullets.
   - New feature bullets may use longer descriptions when needed to explain the shipped capability clearly. Prefer one rich, publish-ready feature line over several short bullets for the same feature.
   - Reserve separate `Fixed` bullets for independent bug fixes or regressions that are not merely pre-release follow-up work for a newly added feature.
   - Prefix every changelog bullet with one existing GitHub label scope in bold square-bracket form, for example `[**Desktop**]`, `[**Backend**]`, `[**provider:codex**]`, or `[**provider:claude**]`.
   - Prefer the label scope from the linked issue or PR. If multiple labels apply, choose the most user-relevant area/provider label. If no issue or PR is linked, use `gh label list` and the affected files to choose an existing label; do not invent new scope names.
   - Avoid contributor/internal framing unless it directly affects users.
   - Keep the changelog factual and concise.
   - The GitHub release page is populated automatically from this exact changelog section by the release workflow, so write it as publish-ready release notes.

4. **Ask for landing news copy**
   - Ask the developer whether this release needs a landing news post and, if yes, what marketing/commercial text they want to show in addition to the changelog.
   - Do not invent the main marketing angle without developer input.
   - If the developer requests no news post, continue with changelog-only release notes and do not create a landing news file.
   - If the developer provides news copy, create a post under `packages/landing/src/content/news/` whose filename includes the release version, for example `cadencr-v0-2-0.mdx`.
   - The post should sell the release clearly while remaining accurate.
   - Stop after `CHANGELOG.md` and any requested landing news post are modified. Show the drafted changelog section and news file path or changelog-only status, then ask the developer to confirm before continuing.
   - Wait for explicit developer confirmation before continuing to version bumps, security review, CI checks, release preparation commit, preflight, tagging, pushing, or asset polling.

5. **Update every application version**
   - Update package versions in package manifests under `packages/*/package.json` that already have a version field.
   - Update Rust package versions in `packages/*/Cargo.toml` that already have a package version.
   - Update lockfiles when the package manager requires it.
   - Do not change unrelated dependency versions.
   - Verify the landing page displays the new version from `packages/landing/package.json` rather than a hardcoded version string.
   - If the landing source still contains hardcoded version labels for the navbar, footer, hero, download blocks, or release CTAs, replace them with the shared landing version source and include that in the release preparation commit.

6. **Run a dedicated security and regression review**
   - If subagents are available, launch a dedicated review agent focused only on security and regressions introduced since the previous tag.
   - Ask it to inspect the diff from `PREVIOUS_TAG..HEAD`, with special attention to secrets, release signing, updater behavior, migrations, data loss, authentication/authorization, command execution, and provider boundary regressions.
   - If subagents are unavailable, perform the same review yourself and document the result.
   - Fix or explicitly escalate every serious finding before continuing.

7. **Check the latest main CI status**
   - The release workflow itself should not introduce application code changes, and pre-commit hooks will catch broken release-prep edits.
   - Instead of rerunning the full local test suite, verify that the latest `main` commit is green before releasing:

```bash
git fetch origin main
MAIN_SHA="$(git rev-parse origin/main)"
gh api "repos/{owner}/{repo}/commits/$MAIN_SHA/check-runs" \
  --jq '.check_runs[] | [.name, .status, .conclusion] | @tsv'
gh api "repos/{owner}/{repo}/commits/$MAIN_SHA/status" \
  --jq '{state: .state, statuses: [.statuses[] | {context, state}]}'
```

   - Continue only if the latest `origin/main` checks are completed and successful, or if the developer explicitly accepts releasing from a non-green main.

8. **Create the release preparation commit**
   - Review the final diff and ensure it contains only release preparation changes.
   - Commit the changelog, optional landing news, version bumps, and lockfile updates before tagging.
   - Use a concise commit message such as `chore: prepare release vX.Y.Z`.
   - The helper script requires a clean worktree so the local tag points at the committed release state.

9. **Run the automated release preflight**
   - Run: `scripts/release.sh "$TAG"`.
   - This checks that the changelog section can be extracted for GitHub release notes, plus optional news/version files, tag and release availability, and trufflehog results.
   - It creates the local annotated tag when all checks pass.
   - If it fails, fix the reported issue and rerun it.

10. **Push the tag manually**
   - Show the critical safety rule again.
   - Run: `git push origin "$TAG"`.
   - The script must not do this step.

11. **Poll GitHub for release assets**
    - Poll until the release exists, is not a draft, and has assets.
    - Use a bounded loop like:

```bash
for i in $(seq 1 120); do
  gh release view "$TAG" --json isDraft,assets,url \
    --jq 'if (.isDraft == false and (.assets | length) > 0) then "ready " + .url else "waiting" end' || true
  sleep 30
done
```

    - Report the final release URL and asset count.
    - If assets do not appear before the timeout, inspect the GitHub Actions run and report the failure.

## Response format

When the release is complete, respond with:

1. `Previous release`: previous tag version only.
2. `Release content`: changelog section and landing news file, or note that the release is changelog-only.
3. `Security review`: review result and any fixes.
4. `Version updates`: files changed.
5. `Tag`: local tag and push status.
6. `GitHub release`: URL and asset count, or the failing workflow status.
