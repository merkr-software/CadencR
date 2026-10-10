# Local plugins — v0.12.0 delivery plan

## Current decision — 2026-09-12 (new projects only)

**Ship local themes and provider connectors in v0.12.0, not a marketplace UI.**
This supersedes the immediate public-marketplace delivery priority in the
[GitHub marketplace plan](./MARKETPLACE_V1.md). That distribution architecture
remains accepted for later; changing this release scope requires a new explicit
decision. Registry provisioning is not a blocker for local authoring.

Both plugin types create an ordinary project and conversation in the developer's
own Cadencr instance. Each newly created project carries durable, queryable plugin-authoring
identity so a later workflow can publish its repository/version to GitHub and
submit the initial or subsequent version to the registry.

**Existing project rows are out of scope:** no backfill, reclassification or
marker repair on reopen. Their current behavior is preserved.

See [domain vocabulary](../CONTEXT.md). A plugin project, an installed plugin,
and a published registry version are separate concepts.

## Source-backed state after implementation

| Area                 | Current implementation                                                                                                                                                   | Scope / remaining verification                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Provider authoring   | **Add provider** scaffolds a new connector or imports an existing built Git repository; both register a local `bin/provider` descriptor and open a project/conversation. | New rows carry `authoring_target=provider` and `plugin_id`; old rows remain unmarked.                                        |
| Theme authoring      | Theme creation prepares the local folder, project and conversation before returning `{theme, workspace}`; the UI opens that returned workspace.                          | Partial setup returns `THEME_PROJECT_SETUP_FAILED`; the retained theme can be reopened to retry without recreating it.       |
| Theme identification | New theme projects use `kind='user'` plus `authoring_target=theme` and `plugin_id`; legacy `kind='theme'` remains readable unchanged.                                    | No migration or reopen path reclassifies existing projects.                                                                  |
| Local runtime        | Installed ACP connector flow, generic model discovery, restart-gated registration and theme application/validation exist.                                                | Complete local lifecycle QA; avoid describing a generated project as an already-implemented connector.                       |
| Resume isolation     | Working-tree changes scope installed ACP capability state to each runtime and gate ID persistence through the live session.                                              | Runtime/WS persistence regression tests pass; packaged-app lifecycle QA remains separate.                                    |
| Future downloads     | Managed package lifecycle, trust, conformance and new signed catalog acquisition/cache exist in backend.                                                                 | Explicitly retained exception to the no-unused-future-mechanisms rule; not a local release prerequisite or a marketplace UI. |
| Registry tooling     | Runnable local validation/index tools and workflow templates exist under `tooling/marketplace-registry/`.                                                                | Not a deployed registry/publisher; no package copying, signing or publication is implemented by the template.                |

Source anchors: `agents/providers/development/workspace.rs`, `themes/workspace.rs`,
`themes/routes.rs`, `projects/models.rs`, `projects/repository.rs`,
`components/theme/ThemeLibrary.tsx` and `agents/providers/installed/`.
Backend paths are relative to `packages/service/src/domain/`; component paths
are relative to `packages/desktop/src/`.

## Existing-folder provider import — 2026-09-13

The local authoring scope also includes **Add provider → From existing folder**.
The developer supplies a name, stable provider ID and existing Git repository root.
The connector must already be built at `bin/provider` (`bin/provider.exe` on Windows).

- Import registers a local descriptor and creates a new ordinary project and
  conversation with `authoring_target=provider` and `plugin_id`.
- Existing source files and Git history are preserved: no scaffold writes,
  automatic build, Git initialization or automatic commit.
- Existing unrelated project rows are not adopted or reclassified. Identity/path
  collisions are rejected; an identical owned import can be retried.
- The folder and executable are structurally validated. Import is not ACP
  conformance certification; only import trusted local code, then restart Cadencr
  to discover and test the connector.
- Native directory selection and manual absolute-path entry belong to this local
  flow. Marketplace browsing, publication and registry submission remain deferred.

Verification on the integrated implementation:

- 19 focused Rust development tests pass on macOS, covering creation/import,
  retry, collisions, invalid roots/executables and symlink canonicalization.
- Full frontend suite: 4,307 tests across 551 files; the final copy-only correction
  was followed by 8 passing dialog tests. TypeScript, desktop lint, knip, Rust
  check/build, formatting and provider-boundary scan pass.
- Real renderer interactions against an isolated running service: import an unborn
  Git repository, navigate to its conversation, show an invalid-folder error and
  recover by importing a valid folder. Final-binary import and retry return the
  same project/conversation IDs; the scaffold API still creates a new connector.
- API checks confirm persisted provider authoring identity and reject an existing
  ordinary project without adding markers. Import leaves a file-hash snapshot of
  the connector source and Git metadata unchanged.
- Restarting the service loads the imported Pi connector as `installed_local`,
  `available`, with eight discovered models. This run does not repeat Pi prompt,
  tool or resume QA; see the earlier Pi QA report for that separate evidence.
- QA used explicit temporary database/settings CLI paths and the real Vite
  renderer, rather than an unrestricted `pnpm dev` against the existing dev DB.
  Native OS folder-picker interaction and packaged Windows/Linux builds were not
  exercised; picker behavior is covered with mocked bridge tests.

Finish-job refinements (2026-09-14) reuse the shared Git-root resolver and the
runtime's executable-file admission rule. Regression coverage also checks complete
content/mode preservation of source and Git metadata (including dirty tracked and
untracked files), native-picker failure recovery and switching back to creation.
The dialog remains within the lint-enforced function-size limit; no extra
state-management abstraction was added.
Finish-job checks: 223 provider Rust tests passed (1 ignored), 13 focused frontend
tests passed, plus TypeScript, desktop lint and knip. The earlier full frontend
and UI QA results above remain applicable to unchanged production frontend code.
The final service build also passed isolated API smoke checks for import/retry,
source/Git preservation, provider markers, and rejection of missing or
non-executable connectors and nested repository paths. Build, Rust check,
formatting and the provider-boundary scan passed.

## Review progress — 2026-09-12

Three `gpt-5.6-sol` reviewers inspected runtime correctness, registry/tooling
quality and theme/provider authoring identity; a further pass checked plan consistency.
Corrections in the working tree include:

- Fail-closed resume persistence when the owning runtime is unavailable; stale
  adapter-cache assertions replaced by live capability checks.
- Same-adapter overlapping sessions with opposite resume capabilities, plus
  public WebSocket/database tests for persistence and restoring connector context.
- Registry SemVer validation/ordering aligned with Rust (including exact large
  integers), mandatory binary delivery and typed package-runner arguments.
- Deterministic fixture clocks, schema-policy regression checks, and real registry
  tooling test execution in root tests, CI and pre-commit.
- Future unsigned cache timestamps no longer suppress catalog refresh.
- Generated frontend API refreshed; no marketplace UI or dead publisher runtime
  added. The template is an executable index-preparation tool, not a publisher.

Earlier review verification: focused runtime integration, managed-provider unit tests, registry Node
tests, 4,296 frontend tests, lint, TypeScript and knip. Local `pnpm dev` API checks
confirmed health, unauthorized catalog refusal, and explicit unconfigured GET/POST
catalog diagnostics. This does not validate remote signed downloads.

Current authoring verification:

- Migration preservation: 1 test; project services/repository: 29 tests; theme
  workspace/routes: 19 tests; provider workspace: 11 tests on each Rust target (lib/main).
- Theme frontend hooks: 16 tests; full frontend suite: 4,299 tests across 550 files.
  Generated API, TypeScript, knip, workspace lint and formatting checks pass.
- Registry tooling: 10 Node tests and its root-suite wiring test pass.
- Additive migration applied to a temporary copy of a real database: all 11
  existing projects remain unmarked; foreign-key check has no violations.
- Isolated running service: theme/provider creations return ordinary marked
  projects; generic project creation remains unmarked; theme reopen returns the
  same project/conversation. After restarting that service, provider retry also
  returns its original IDs; both plugin markers survive and the ordinary project
  remains unmarked. A provider identity owned by another path returns
  `PROVIDER_PROJECT_OWNERSHIP_CONFLICT` before creating any workspace files
  (unit tests and final live API negative check).
- Real renderer DOM interactions: create theme, automatic apply/navigation,
  reopen theme with the same IDs, and create provider/navigation all pass.
  Browser outline/viewport tooling was unreliable, so this is interaction proof,
  not a screenshot-based visual/layout sign-off.
- Full connector edit/build/use and supported packaged-target lifecycle QA remain
  open; creating the provider scaffold does not implement its executable.

## Finish-job review — 2026-09-13

Three parallel `gpt-5.6-sol` reviewers checked reuse, quality and efficiency.
The final diff additionally:

- Reuses the provider project's validated ID instead of querying and interpreting
  its marker twice; the ownership preflight still precedes filesystem mutation.
- Serializes catalog acquisition, validates freshness after download and before
  cached fallback, and bounds the actual serialized cache before atomic writes.
- Tests signed cache round-tripping at the envelope limit, rejects an oversized
  replacement without overwriting the previous cache, and rejects expired fallback.
- Covers retained theme creation after project-setup failure and an idempotent retry.
- Derives registry allowed-field sets from the schemas, returns diagnostics for
  malformed metadata, uses Rust-compatible UTF-8 key ordering, and emits signing
  payloads without a trailing newline. Portable fixtures are checked against the
  service bytes; standalone-copy tests prevent monorepo-only tooling assumptions.

Current checks: full frontend 4,299/4,299; focused providers 216 passed with one
pre-existing ignored OpenCode binary probe; projects 29; themes 108; marker
migration 1; resume-ID helpers 5; missing-runtime gate 1; final catalog suite 6.
The public ACP/WebSocket integration passes (1 test); its first sandboxed run
was blocked from binding a local socket, then passed with local-network permission.
TypeScript, knip,
lint, formatting and diff checks pass. Node tooling has 14 tests plus two root
wiring/fixture-parity tests. Fresh isolated API QA passes theme/provider creation,
retry without duplicate IDs, reserved-provider refusal before filesystem changes,
project markers, ordinary unmarked projects and unconfigured catalog diagnostics.

No new visual/layout or packaged lifecycle sign-off is implied. Cache expiry
coverage uses controlled verification times, not a delayed HTTPS server; a
concurrent remote-download test remains outside this local QA. The initial finish-job pass stopped before staging or committing. The four-commit
local plan was subsequently approved; pushing or releasing remains a separate action.

The complete pre-commit suite also exposed an older usage-checkpoint migration
fixture with no `projects` table. Its in-memory pre-migration schema now includes
that existing table so subsequent migrations execute against a realistic shape;
no production migration or real database was changed for this correction.

## Durable plugin-project marker

The working tree implements the following additive schema and creation contract.
It applies only when a project row is newly inserted:

| Field/meaning               | Implemented representation                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Ordinary workspace behavior | Keep `projects.kind='user'` for both plugin types.                                                         |
| Authoring target            | Nullable typed discriminator `authoring_target` holding `null`, `theme` or `provider`; not just a boolean. |
| Plugin identity             | Persist `plugin_id` with the marker in the same INSERT; the pair identifies one authored plugin.           |
| Publication state           | Separate future concern; local projects need no GitHub URL, registry entry or published version to exist.  |

Requirements:

- Return the marker through project APIs so projects can be queried/filtered
  without inferring type from names, folders or installed-provider lists.
- Rename, reopen, app restart and normal conversation/worktree operations preserve
  identity; plugin authoring must not introduce a special layout/runtime mode.
- Creation/recovery is idempotent: the same plugin opens the same project without
  duplicate conversations or cross-type adoption. Surface partial failures and
  offer retry; do not silently report a successful complete authoring setup.
- Theme creation must complete the project/conversation path as part of the
  authoring operation, or report that project setup still needs retry. Filesystem
  and database changes do not require pretending to be one atomic transaction.
- Later GitHub publication uses this identity to select the theme/provider
  contract and submit either the first version or a subsequent version. Do not
  implement inactive publish buttons, empty dispatchers or speculative state now.

### Additive migration, no backfill

- `20260912090000_project_authoring_marker.sql` adds nullable marker/identity
  columns and constraints/indexes only; it performs no UPDATE/DELETE/backfill.
- Existing ordinary and theme project rows keep their original IDs, kinds,
  paths, conversations and null marker values. Reopening does not label them.
- New theme/provider projects insert both marker and stable plugin ID atomically,
  keeping `kind='user'`; new ordinary projects remain unmarked.
- Matching marked projects are reused idempotently; conflicting marked identities
  are refused, not reassigned. Legacy lookup compatibility remains active without
  inferring provenance or writing a new marker.
- Migration tests must prove existing rows/children unchanged and foreign keys
  valid. Verify only on temporary database copies; never migrate a real user DB
  as part of verification. No new migration rewrites the old project-kind history.

## Release checklist

- [x] **L1 — Persist plugin-project identity.** Additive migration, typed marker,
      atomic new theme/provider insertion and regenerated project API are implemented.
      Existing rows remain unchanged. Migration/ownership tests and live project-list
      checks pass; broader packaged lifecycle coverage remains in L4.
- [x] **L2 — Complete both local authoring paths.** Theme creation/open and provider
      generation create the associated project/conversation. Theme partial failures
      retain a retryable theme; provider retry only reuses an owned scaffold with
      its exact generated descriptor, never a built-in or unrelated installation.
      Native CLI account setup remains outside Cadencr.
- [x] **L3 — Close local correctness and dead-code review.** Resume isolation and
      persistence regressions are covered, stale assertions corrected, and registry
      tooling checks wired into CI. Format/lint/TypeScript/knip and focused Rust/Node
      plus full frontend tests pass. Download infrastructure remains the only
      approved future-facing runtime exception; no publisher/marketplace UI added.
- [ ] **L4 — Exercise the local release.** In the running app, create a theme and a
      provider, find each project by its persisted marker, reopen without duplicates,
      edit/build/apply/use it, restart, and confirm project identity survives. Test
      resumable/non-resumable connectors together and preserve transcripts. Verify
      failures, retry, rename and cleanup on supported packaged targets.
      **macOS arm64 themes passed packaged UI QA on 2026-09-17**, including live
      edits, invalid-theme recovery, full restart, stable identity and native Trash
      preservation. Packaged-provider coverage and the remaining target matrix
      still prevent closing the broader gate.
- [ ] **L5 — Record release readiness.** Update verified results and unresolved
      v0.12.0 blockers; do not infer readiness from compilation alone. No remote
      registry, signing key, marketplace UI or publisher portal is required for L1–L4.

## Remaining release work

1. Generated-scaffold/build/use/rebuild and mixed resume/non-resume host behavior
   now pass in the development app with deterministic connector fixtures; see the
   [2026-09-16 QA report](./qa/LOCAL_PLUGINS_QA_2026_09_16.md). The external Pi connector
   separately passed real model/permission/resume QA in the
   [2026-09-13 report](./qa/LOCAL_PLUGINS_QA_2026_09_13.md). Neither result alone
   certifies a new production AI connector or closes packaged lifecycle gate L4.
2. Extend packaged lifecycle coverage to providers and the remaining release
   target matrix. **macOS arm64 theme QA passes** in the actual packaged Electron
   app: creation/application, in-app and external live edits, automatic rename,
   invalid-theme recovery, reopen, full restart and native Trash cleanup preserving
   all 34 theme/Git files. See the final section of the
   [2026-09-17 packaged QA report](./qa/LOCAL_PLUGINS_QA_2026_09_17.md).
   Isolated pnpm inspection unblocked packaging; launching from Terminal unblocked
   native UI QA. The earlier watcher failure does not reproduce there. Production
   DB/WAL/SHM remain unchanged. These theme checks alone do not close L4/L5.
   The residual project-settings `404` after theme/project deletion is fixed by
   list-only query invalidation and verified in isolated dev UI QA on 2026-09-18;
   creation, cancellation, deletion and reload pass, with 15 focused tests green.
3. Record remaining v0.12.0 blockers and review integration with the target branch
   before proposing a merge. Implementation is locally committed as `0f13ac748`;
   the current QA documentation update is not a merge/push/release authorization.

There is no registry provisioning blocker for the local milestone. The public
GitHub publication workflow and marketplace UI remain deliberately deferred.

## Later publication workflow

1. Select a marked theme/provider project in Cadencr.
2. Publish source and an exact version to its GitHub repository.
3. Validate/package with the matching content contract.
4. Submit the initial entry or new version through a metadata PR to the registry.
5. After approval, the future protected publication pipeline mirrors approved
   packages to Cadencr-owned GitHub Releases and publishes signed metadata.

The flag enables this future workflow; it does not mean the workflow exists now.
Registry keys/URLs, mirroring/signing operations, download isolation gates and
marketplace UI remain deferred in [Marketplace V1](./MARKETPLACE_V1.md).
