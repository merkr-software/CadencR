---
name: finish-job
description: Simplify the current implementation, review the behavior it changes, ensure sufficient test coverage, re-verify the final diff in the running app, and present a commit plan for user approval before any commit.
argument-hint: [scope or notes]
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash(git *) Bash(pnpm *) Bash(cargo *) Bash(curl *) Read Grep Glob Edit Write Agent Skill
---

# Finish Job

Complete the current implementation responsibly, but stop before creating a commit.

Additional scope or notes:
$ARGUMENTS

## 1. Identify the active change set

Run `git status` and `git diff` first.

- Work only from the current-session changes.
- If unrelated files are already modified, do not revert, stash, or include them unless the user explicitly asks.
- If nothing is changed in git, inspect the files most recently edited in this session and use that as the working set.

## 2. Simplify the implementation

Review the full working diff before editing. Prefer the smallest correct simplification.

This phase must use four separate review agents in parallel when the environment supports subagents. The goal is to give each reviewer a small, isolated context centered on the diff, not the main conversation history.

Before launching them:

- Capture the full current diff once. Write it to a worktree-safe tmp path that embeds the current branch name so concurrent Cadencr worktrees do not clobber each other's diffs. Use the current branch (falling back to the short SHA for detached HEAD) and slug it for the filesystem:

  ```bash
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  [ "$BRANCH" = "HEAD" ] && BRANCH="$(git rev-parse --short HEAD)"
  SAFE_BRANCH="$(printf '%s' "$BRANCH" | tr '/ ' '--')"
  DIFF_FILE="/tmp/finish-job-diff-${SAFE_BRANCH}.patch"
  git diff > "$DIFF_FILE"
  ```

  Never reuse a static path like `/tmp/finish-job-diff.txt` — parallel worktrees on different branches would overwrite each other.
- Pass that diff file (or its contents) to all four agents.
- Tell each agent to review the diff brutally and flag anything weak, redundant, sloppy, or avoidable.
- Tell each agent to focus only on the current diff and not to rely on broader conversation context.

Launch these four review agents concurrently in a single message:

### Agent 1: Reuse review

Ask this agent to:

- Search for existing helpers, utilities, hooks, or patterns that can replace newly written code.
- Flag duplicate logic and point to the better existing abstraction when one exists.
- Call out any new helper, wrapper, or branch that should have reused code already present in the repo.
- Be strict about avoiding new code when existing code was already good enough.

### Agent 2: Quality review

Ask this agent to:

- Remove redundant state or cached values that can be derived.
- Collapse parameter sprawl where a simpler shape or existing abstraction is enough.
- Unify copy-pasted logic with slight variation.
- Fix leaky abstractions and stringly-typed additions.
- Remove unnecessary wrappers, nesting, and comments that only narrate what the code already says.
- Treat awkward, over-engineered, or defensive-but-unnecessary diff hunks as issues, not style preferences.

### Agent 3: Efficiency review

Ask this agent to:

- Remove redundant work, repeated reads, duplicate requests, and other unnecessary operations.
- Parallelize independent work where the codebase already supports that pattern.
- Avoid hot-path bloat, recurring no-op updates, unnecessary existence checks before the real operation, and overly broad reads.
- Clean up obvious memory or listener leaks.
- Treat wasteful code in the diff as a real defect even if it is functionally correct.

### Agent 4: Behavior review

Ask this agent to:

- List every behavior a user or a client of the code can observe that the diff changes: ordering, timing of statuses, what is retried or cached, error codes and messages, what happens under load, cancellation, reconnect, restart, or on the other platform (macOS and Linux).
- For each one, say whether the change is intended, and flag the unintended ones as bugs with a concrete failing scenario.
- Check that comments and docs touched by the diff, or describing code it changed, still match the code.
- Flag tests that would still pass if the behavior regressed (asserting implementation details instead of outcomes).
- Return the list of behaviors as the scenario list for the QA in section 4.

If subagents are unavailable, perform the same four reviews yourself in that order, still using the full diff as the review target.

Wait for all four review results, aggregate them, and then apply the worthwhile fixes directly. Do not preserve weak code just because it already works. If a finding is not worth fixing, note it briefly and move on.

## 3. Ensure tests are sufficient

After simplification, review the current-session changes for testing gaps.

- Add or update tests for changed behavior using existing project patterns.
- Run the relevant tests and make sure they pass.
- For Rust tests, search the output for `FAILED` instead of trusting exit status alone.
- If current coverage is already sufficient, say so explicitly.

## 4. Re-verify behavior in the running app

Simplifications and review fixes change code after any earlier QA, so that QA no longer covers the final diff.

- If the change has any runtime effect (not only docs, comments or tests), run the `qa` skill on the final working tree before planning commits.
- Exercise every behavior listed by the behavior review, plus the scenarios of any earlier QA whose code changed since. Follow the `qa` skill's surface rules: any change with a user-visible consequence is checked in the real Electron app, never only in the headless renderer or through API calls.
- Report each scenario with the action and the observed result. If a scenario could not be exercised, say so and why; do not present the work as verified without it.
- If QA finds a problem, fix it, add a test, and rerun the affected scenarios.

## 5. Prepare a commit plan only

Do not stage files, do not create a commit, and do not push during this initial `finish-job` run.

Build a commit plan from the final diff:

- Use one commit when the change is small and cohesive.
- Use multiple commits when there are distinct logical units that should be reviewed separately.
- For each planned commit, include a concise title and one short sentence explaining why it exists.
- Mention which files or areas belong in each commit.

Then ask the user for approval before any commit is created.

## 6. Commit execution rules after approval

If the user approves the commit plan in a later turn, continue with the approved plan and preserve these safety rules from start to finish:

- Re-check `git diff` and `git status` and still work only from current-session files.
- Do not run `git stash` unless the user explicitly asks for it.
- Do not use `--no-verify` or `--no-gpg-sign` unless the user explicitly asks to skip hooks.
- If pre-commit hooks fail, fix the issue and retry; do not bypass the hooks.
- Stage only the approved files by name. Do not use `git add -A` or `git add .`.
- Include any new or updated test files that belong to the approved plan.
- Write concise commit messages that explain why, not just what.
- Use a HEREDOC for multi-line commit messages.
- Do not push unless the user explicitly asks.
- Run `git status` after the final commit to confirm success.

## 7. Response format

Respond with:

1. `Simplification`: what you simplified, or that no worthwhile simplification was needed.
2. `Tests`: what you added or ran, or why existing coverage is sufficient.
3. `QA`: the scenarios exercised after the final changes, with surface and results, and any that could not be run.
4. `Commit plan`: the proposed single-commit or multi-commit plan.
5. `Approval needed`: explicitly ask whether to proceed with the planned commit structure.
