# Marketplace V1 — GitHub-only distribution

## Execution update — 2026-09-19

Marketplace implementation is now authorized, following the local-plugin work.
This does not change the published v0.12.0 scope or authorize a remote repository,
release, push, registry publication, or production-data changes.

The first implemented distribution contract remains **ACP providers**. Theme
projects already carry authoring identity, but theme distribution requires its own
contract; including themes in the first public marketplace is awaiting confirmation.

### Current foundation

- Local authoring/import and new-project `authoring_target` / `plugin_id` markers
  are committed. Existing projects are not backfilled or reclassified.
- Session-scoped resume eligibility is implemented and tested.
- Signed catalog acquisition/cache and managed installation APIs exist; their
  existence does not imply a configured production registry or a marketplace UI.
- Registry validation/index preparation exists. The original workflow templates
  do not mirror archives, sign payloads, or publish releases.
- Local changes were rebased onto `v0.12.0`; integration checks passed. Packaged
  provider lifecycle and supported-platform coverage still need completion.

### Execution sequence and gates

| Step | Deliverable                                                          | State                                                                                                               |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A    | Strict source/version submission contract and governance             | Local contract implemented and reviewed; official repository, platform and isolation policies remain open           |
| B    | Reproducible author packaging, guide and conformance workflow        | Local packer and guide implemented/reviewed; reusable conformance workflow and platform certification pending       |
| C    | Registry bootstrap and unprivileged contribution CI                  | Local immutable contribution gate and isolated CI template implemented; deployment and live GitHub checks pending   |
| D    | Protected mirroring, signing and idempotent publication              | Operator pipeline, published-state recovery and protected workflow template implemented locally; deployment pending |
| E    | Publish first/new version from a marked Cadencr project              | E1 readonly local preparation implemented/reviewed and dev-QA verified; packaging and GitHub publication pending    |
| F    | Production URLs, trust roots, policy renewal and catalog integration | Backend foundation exists; production configuration absent                                                          |
| G    | In-app browsing, installation and installed-version management       | Not implemented                                                                                                     |
| H    | Revocation operations and incident recovery                          | Backend foundation exists; operational policy absent                                                                |
| I    | External-author and packaged-app lifecycle on supported targets      | Pending                                                                                                             |

Each implementation step uses delegated workers and parent review, followed by
reuse/quality/efficiency review and relevant checks before proceeding. Changes
remain uncommitted until a proposed commit is explicitly approved. Public opening
requires all runtime, trust, operational and packaged-app gates; local tooling
alone cannot close them.

### Local tooling verification — 2026-09-19

- Source-pinned submission validator and bounded CLI: 14 tests pass.
- Deterministic streaming author packer: 27 tests pass, including source-mutation,
  symlink, portability, resource-limit, backpressure and cleanup-error cases.
- Combined registry suite: 55 tests pass. Existing managed wire-format fixtures
  remain unchanged. These are local CLI tests, not GitHub or packaged-app QA.
- Separate reuse/quality/efficiency reviews completed for both local increments;
  findings were corrected and retested. No remote deployment or Git delivery.
- The packer requires trusted, quiescent staging; it is not an OS sandbox.

### Contribution validation increment — 2026-09-19

- Added a local base/candidate snapshot validator: immutable published versions,
  matching source-pinned submissions for new versions, publisher/repository
  continuity, and normalized provider-ID collision rejection.
- Reads are bounded to 1 MiB per JSON file, 10,000 entries per metadata directory,
  and 32 MiB per root across packages/submissions, including malformed JSON.
  Snapshot inputs must remain stable; symlinks and special files are rejected.
- The PR template separates trusted-base inert metadata validation from untrusted
  candidate tooling tests. Neither job has publication authority or signing secrets.
- Empty-catalog bootstrap is supported; demonstration data is a test fixture,
  not a required published package. Remove the demonstration catalog entry before
  establishing the official registry baseline.
- Three independent GPT-5.6-Sol reuse/quality/efficiency reviews completed;
  shared identifier normalization and temporary-fixture cleanup were corrected.
  The full local registry suite passes 69 tests, including actual CLI invocations
  and the empty-catalog workflow shell guard; the root integration checks pass.
- Deployment, a real GitHub PR run, repository protections, and protected
  publication-time revalidation remain unverified or unimplemented. Local checks
  do not prove source ownership or establish an official publisher identity.

### Publication primitives increment — 2026-09-19

- Deterministic local mirror planning preserves the original source submission,
  approved digests and archive formats while deriving immutable destination names.
- The local Ed25519 signer uses the existing canonical index/envelope contract,
  validates the publication window, self-verifies, and refuses output overwrites.
- Both commands operate on bounded regular files without network calls or provider
  execution. The integration test connects a plan to a signed fixture index with
  ephemeral keys; it does not establish remote asset availability or source trust.
- Three independent reuse/quality/efficiency reviews completed. They prompted
  temporary-fixture cleanup and a cross-language signing correction: the signer
  refuses noncanonical dates and empty optional fields that Rust would omit.
- Verification: 81 local registry tests and two root integration checks pass;
  a Rust integration test invokes the actual Node CLI and verifies its signature
  through `ManagedTrustStore`, including tamper rejection. No app runtime behavior
  changed; no production data or keys were used.
- This is a **partial implementation of D**, not an operational publisher. The
  remaining work includes source/digest verification, mirrored remote assets,
  conflict-safe retries, serialized publication and discovery updates, provenance
  retention, and protected production key/environment provisioning. Neither CLI is
  connected to the bootstrap workflow yet; it still stops before signing/releases.

### Verified archive staging increment — 2026-09-19

- Added `stage:publication`: revalidate the source submission, derive the mirror
  plan, stream public source archives over an explicit HTTPS redirect allowlist,
  and verify submitted SHA-256 digests before local finalization.
- Limits: 256 MiB per archive, six sequential targets, three redirects and a
  two-minute download deadline. No tokens/cookies, extraction or provider execution.
- Local retries rehash existing archives and reuse matching bytes without network
  requests. Conflicts fail without overwrites; completed archives survive later
  failures. A canonical receipt is created only after every target verifies.
- Exclusive staging lock and no-overwrite file publication protect concurrent
  attempts. Receipt reads are bounded to 4 MiB; staging paths/ancestors must remain
  trusted and stable. Crash recovery is manual; stale locks are never auto-deleted.
- Three independent GPT-5.6-Sol reuse/quality/efficiency reviews completed. Shared
  publication CLI parsing/loading replaced duplication; cleanup preserves primary
  errors and receipt serialization supports reordered equivalent input.
- Verification: 100 registry tests and two root integration checks pass, with
  lint/format checks. The actual staging CLI was exercised against a local HTTP
  fixture server via test-only transport routing: redirect/stream/hash, no-network
  replay, and corrupt-final refusal pass. This is not live GitHub/CDN/TLS QA.
- This increment verifies **local received bytes**, not uploaded GitHub assets.
  Source ownership/build provenance, GitHub upload/reconciliation, remote digest
  verification, protected signing orchestration, serialized catalog publication
  and discovery updates remain unfinished. No official registry was provisioned.

### GitHub draft mirroring increment — 2026-09-19

- Added an explicit operator command that consumes fully staged source archives,
  records the canonical plan as a provenance asset, and fills a GitHub draft
  release without replacement/deletion or publication.
- A destination confirmation, exact registry commit and dedicated token are
  required. API/upload destinations are fixed; credentials are not forwarded to
  asset CDN redirects. Asset verification re-downloads actual remote bytes.
- Existing assets are verified, not trusted from metadata digests alone. Ambiguous
  write responses are reconciled before retry; conflicts and incomplete assets
  require investigation rather than destructive recovery.
- Draft verification is not public availability. Protected draft promotion, public
  destination checks, signing orchestration, catalog/blocklist release/discovery,
  cross-runner serialization and actual GitHub deployment/QA remain pending.
- Verification: 125 registry tests and 2 root integration checks pass, including
  the real CLI against a local mock GitHub API/CDN (creation, replay without new
  writes, and corrupted remote bytes). No actual GitHub writes were performed.
  Three GPT-5.6-Sol reviews completed; shared owned-lock cleanup and exact commit
  validation were consolidated. Formatting and diff checks pass; lint reports
  only four existing control-regex warnings in unchanged packaging/submission code.

### Explicit promotion increment — 2026-09-19

- Added a separate operator-only promotion command requiring exact repository and
  release-tag confirmation, the existing mirror receipt and freshly verified
  staged/remote bytes. It never creates releases/tags or replaces/deletes assets.
- Promotion checks the actual tag commit (including bounded annotated tags), not
  only `target_commitish`, before and after the publication mutation. Missing or
  conflicting tags require operator investigation before publication.
- After publication, public archive and provenance URLs are downloaded without
  credentials before an immutable publication receipt is written. Failed public
  verification leaves the release published but produces no new success receipt;
  replay reconciles and verifies without republishing.
- This is a local operator primitive, not deployed protected publishing. Repository
  protections, release immutability, distributed concurrency, signing/catalog
  orchestration and live GitHub QA remain pending. No real GitHub mutation or
  production-data access is part of this increment's tests.
- Verification: 143 registry tests and two root integration checks pass, including
  the actual mirror/promotion CLIs against a local mock API/CDN, mismatched tags,
  public unavailability followed by recovery without republishing, canonical
  receipt replay, mutation during verification, and owned temporary-file cleanup.
  Three GPT-5.6-Sol reviews completed; binding, asset verification and receipt
  publication helpers were shared between mirroring and promotion. Parent review,
  scoped lint, formatting and diff checks pass on the final code.

### Verified catalogue signing increment — 2026-09-19

- A strict operator manifest selects previously promoted provider versions. The
  catalogue gate validates reviewed submissions and both receipts against freshly
  hashed staged artifacts, then derives the mirrored package metadata.
- All packages, identity consistency, timestamps and resource limits are checked
  before public transfers. Every included archive and provenance asset is downloaded
  without credentials and digest-checked before the private signing key is read.
- The existing canonical Ed25519 signer is shared rather than reimplemented; the
  resulting envelope retains the current Node/Rust wire contract. Existing output
  paths are refused, not overwritten. No contributor code is executed.
- This increment writes a local signed catalogue only. It does not deploy a signing
  environment, publish a catalogue release or advance discovery. Continuity against
  the previous official index, monotonic publication, distributed concurrency and
  public verification of uploaded signed snapshots remain publication-time gates.
- Manifest/staging files are trusted operator inputs, not PR artifacts or proof of
  publisher ownership. No real registry token, signing key or production data is
  used in tests; GitHub/CDN/TLS deployment QA remains pending.
- Three GPT-5.6-Sol reviews completed. Corrections include key-ID validation before
  downloads/key access, a fresh signing-time clock, incremental aggregate-budget
  rejection, and shared exclusive file publication through owned temporary files.
- Verification: 156 registry tests, two root integration checks and the Rust
  integration test validating actual Node signatures all pass. The actual CLI was
  exercised against a local mock GitHub/CDN with an ephemeral Ed25519 key, including
  unavailable/corrupt public data, deterministic signing and overwrite refusal.
  Scoped lint, formatting and diff checks pass after parent review/corrections.

### Versioned catalogue publication increment — 2026-09-19

- An explicit snapshot publisher verifies the candidate and supplied previous
  catalogue with an operator-pinned Ed25519 public key. It requires monotonic
  publication time and unchanged retention of previous versions; baseline key
  rotation, delisting and revocation are not silently inferred.
- Published envelope bytes are limited to 1 MiB, matching the existing app's
  acquisition limit. The manifest must reconstruct the exact signed payload and
  public provider archives/provenance are freshly verified before remote writes.
- A deterministic catalogue release binds the envelope digest, registry commit
  and prior digest. The tag must already resolve to the reviewed commit. Publication
  reconciles retries without asset replacement/deletion, and verifies the public
  signed snapshot before writing a local success receipt.
- Initial `bootstrap` and previous baseline selection are explicit operator inputs,
  not proof of remote discovery state. The current app consumes a signed envelope
  directly; no incompatible discovery-pointer format is introduced.
- No `latest` or discovery URL is changed. Protected workflows, authoritative
  discovery continuity/concurrency, official repository/URLs, blocklist operations
  and live GitHub QA remain outstanding. Tests use only mocks and ephemeral keys.
- Three GPT-5.6-Sol reviews completed. Parent corrections cover first-publication
  receipt absence, owned upload temporaries, symlink rejection before locking,
  release identity across PATCH responses and freshness before the final receipt.
  Historical expiration allowance now uses an explicit shared validation policy;
  a redundant paginated asset-list request was removed.
- Verification: 177 registry tests, two root integration checks and the Rust
  Node-signature interoperability test pass. The actual staging/mirroring/promotion,
  signing and snapshot publishing CLIs run against a local mock GitHub/CDN;
  lost responses, tag conflicts, public unavailability/recovery, signature tampering,
  history mutation and no-overwrite replay are covered. Scoped lint, formatting
  and diff checks pass. No real GitHub write or production-data access occurred.

### Stable catalogue discovery increment — 2026-09-19

- Added an explicit discovery advancer for a fixed `managed-index.json` on an
  existing, operator-selected GitHub branch. The stable raw URL serves the signed
  envelope directly, compatible with the existing app acquisition contract.
- Requires the exact D6 publication receipt, verified release/tag/public snapshot,
  and revalidated source manifest. The current remote catalogue must match the
  approved signed baseline, or already contain the candidate for safe replay.
- Conditional Contents API writes bind the previous Git blob SHA. Missing files
  require explicit bootstrap; conflicts never trigger blind retries with a new SHA.
  Lost write responses reconcile against exact candidate bytes.
- Git tree mode and immutable commit-pinned reads reject symlinks and inconsistent
  metadata. Unauthenticated raw verification and a final freshness/head check
  precede the immutable success receipt. A failed check may leave the remote file
  advanced without a receipt; recovery verifies again without destructive rollback.
- Hardened the existing **unsigned preparation** workflow: default-branch gate,
  exact dispatch SHA checkout, read-only credentials and a shared non-cancelling
  publication lane. The complete privileged hosted-runner pipeline is **not wired**;
  required environment reviewers and branch protections are not provisioned.
- Verification uses actual CLIs against local HTTP GitHub/CDN fixtures and ephemeral
  keys, not live GitHub deployment or packaged-app QA. No production data, private
  production key, real publication, push or official registry provisioning occurred.
- Three independent GPT-5.6-Sol reuse/quality/efficiency reviews completed. Their
  findings prompted commit/tree proof for symlink rejection, post-verification
  freshness enforcement and removal of duplicate replay requests. Parent review
  also added malformed-receipt preflight and signed-baseline regression coverage.
- Verification: **197 registry tests**, two root integration checks and the Rust
  Node-signature interoperability test pass. Scoped lint has no errors (four
  pre-existing control-regex warnings); formatting and diff checks pass.
- Next: compose the protected publishing pipeline, then the marked-project author
  release flow. Production trust/URLs, blocklist operations, marketplace UI and
  supported-platform lifecycle certification remain separate pending gates.

### Protected pipeline assembly increment — 2026-09-19

- Added a repository/commit/request-digest-bound operator pipeline composing all
  existing stages: source staging, immutable tag creation, mirroring, promotion,
  verified signing, versioned snapshot publication, then stable discovery.
- Inputs are reviewed inert JSON/public-key/baseline files. Bounded preflight checks
  all submissions, ownership/normalized identities, dates, signing-key match and
  signed baseline continuity before remote writes. No archive is executed/extracted.
- Tags are created only when the exact reference is absent; existing tags must
  resolve to the approved commit. No tag replacement, deletion or force update.
- Pipeline state and copies of public inputs are immutable for one request/commit;
  same-request retry revalidates receipts and bytes. Partial failures preserve remote
  progress instead of rolling it back. Signed output remains gated on verified
  public archives and provenance, not merely planned destinations.
- Added a manual protected publisher workflow template with secret-free digest
  preflight, default-branch/exact-commit checks, shared concurrency, dedicated
  step-scoped credentials, private-key storage outside state, owned cleanup and
  run-specific recovery artifacts. The prior unsigned preparation template remains
  a separate non-publishing tool.
- **Not deployed or unattended:** official repository/trust configuration, protected
  environment reviewers and branch/tag/release policies remain external gates.
  Automatic state hydration across runners or subsequent catalogue requests is
  not implemented. Missing receipts for an already-published provider fail closed;
  recovery currently requires an operator to inspect and reuse the original state
  at the same reviewed checkout/commit. Do not mistake artifact retention for an
  automatic safe resume mechanism.
- Three independent GPT-5.6-Sol reuse/quality/efficiency reviews completed. Shared
  identity/ownership validation replaced duplication. Corrections enforce a shared
  1 GiB staging allowance, reject signing keys inside uploaded state, and preserve
  owned cleanup through symlink attacks. Independent hash/public-byte checks remain
  at security boundaries; the staging cap is not a total network-traffic cap.
- Verification: **228 registry tests**, two root integration checks and the Rust
  Node-signature interoperability test pass. The actual CLI runs against local
  mock GitHub/source/CDN endpoints, covering public-provider failure before signing,
  lost discovery response, safe replay and a later tag conflict without advertising
  a partial catalogue. Workflow inline key scripts are executed locally in tests.
  Scoped lint has no errors (four unchanged control-regex warnings); formatting and
  diff checks pass. This is not live GitHub/Actions or packaged-app QA.
- Next: implement verified published-state hydration and hosted-runner recovery,
  then exercise the actual GitHub deployment under explicit authorization. Continue
  with marked-project author releases, production policy, marketplace UI and the
  external-author/packaged-app lifecycle gates after their prerequisites.

### Verified published-state recovery increment — 2026-09-19

- Fresh runners stage known-published versions from their reviewed official
  mirror URLs, using the same approved hashes and shared 1 GiB staging budget.
  Missing/corrupt public mirrors never trigger fallback to author URLs.
- Local mirror receipts may be reconstructed only after exact release/tag/commit/
  binding checks, complete asset-set validation, authenticated remote-byte checks,
  public archive/provenance verification and final release/tag revalidation.
  Recovered receipts use `published_recovered`, not a fictitious draft observation.
  Existing conflicting local receipts are never overwritten.
- The regular promotion, signing, snapshot and discovery gates remain in place.
  A fresh state directory can replay the same request without duplicate writes.
  Subsequent requests retain the signed baseline, all previous packages and each
  historical provider's original registry commit while adding new reviewed versions.
- Versions in the verified signed baseline require a still-published exact release.
  A read-only release/tag prepass runs before source downloads; missing/draft
  historical versions fail without author fetches or remote writes. Observed
  published state is latched for the invocation, and recovered/publication receipts
  also prohibit later re-promotion. Explicit bootstrap cannot infer deleted history
  when neither a baseline nor any local/remote publication marker exists.
- Recovery relists the complete asset set and re-verifies authenticated bytes after
  public checks, then checks release/tag again before receipt creation. Sequential
  API verification is not an atomic remote transaction; later privileged changes
  remain governed by repository protections and consumer digest/signature checks.
- No Actions artifact is imported or executed. The manual protected workflow now
  relies on verified remote reconstruction rather than a retained local receipt.
  Exact commit/request/window approval still applies; expired requests fail closed.
  Unpublished drafts still require author archives if their local staging is lost.
- This is locally verified orchestration, not a deployed GitHub service. Official
  repository/trust configuration, required environment reviewers and protection
  rules, real Actions QA and supported-platform packaged-app gates remain open.
- Three independent GPT-5.6-Sol reuse/quality/efficiency reviews completed. Existing
  binding, asset, locking and promotion verifiers were reused. Review corrections
  cover historical-release regression and delete/reupload races; multi-platform
  packages sharing one reviewed archive remain supported. The authoritative
  release prepass is retained as a safety gate rather than removed for fewer reads.
- Verification: **250 registry tests**, two root integration checks and the Rust
  Node-signature interoperability test pass. Actual CLI tests use local mock
  GitHub/CDN endpoints: clean-state retry without author archives or new writes,
  subsequent version retention, and missing/draft historical releases with zero
  author downloads and zero remote writes. Scoped lint has no errors (four unchanged
  control-regex warnings); formatting and diff checks pass. No real GitHub, Actions,
  production keys/data or packaged app was used.
- Next: provision and exercise the official GitHub registry under explicit approval,
  or continue the marked-project author publication flow without deployment. Theme
  distribution, production trust/blocklist operations and marketplace UI remain
  distinct scope and release gates.

### Project publication preparation increment (E1) — 2026-09-19

- First increment: readonly local preparation inspection from the settings of
  explicitly marked provider projects. Existing unmarked projects are not
  reclassified; theme distribution remains outside this provider contract.
- Inspect the current local authoring identity, host descriptor, stable build
  output and Git state without executing the connector or contacting GitHub.
  Optional authoring documentation and metadata are advisory: a host-local
  descriptor is not the managed package or registry submission.
- The UI distinguishes blockers, advisory checks and local preparation success.
  Success is not release approval or proof of ACP conformance, archive contents,
  source ownership, release availability or registry acceptance.
- Next E increments must define explicit author-controlled package metadata and
  staging inputs, prepare exact-version artifacts, then offer separately confirmed
  author-repository publication and registry contribution. The app must not use
  the protected official registry signing credentials or bypass maintainer review.
- Verification: 6 targeted Rust tests and 30 frontend tests pass, including
  authoring visibility, warning-only aggregation, error details, and readonly
  inspection. Desktop typecheck/Knip, workspace lint, formatting and diff checks
  pass. Three delegated review perspectives and parent correction review closed
  the identified findings; no commit or push is included in this increment.
- Live dev QA: authenticated API checks cover blocked-to-corrected preparation,
  unsupported/unknown projects and unauthorized access. Repository/descriptor
  hashes remain unchanged and connector/fsmonitor sentinels remain untouched by
  readiness requests. Real browser interactions and screenshots verify provider
  visibility, absence on ordinary projects, loading/error, manual refresh and
  blocked-to-warning-only correction. This is dev QA, not packaged-app or GitHub
  publication QA. The existing CSP meta warning and expected network errors
  during the deliberate service restart were observed; a non-Git test fixture's
  unrelated icon scan failed until the fixture was initialized as a Git repo.
- No GitHub write, registry deployment, production configuration or
  production-data change is authorized.
- QA launcher correction: debug service dotenv loading overrides inherited
  environment variables. The initial launch opened the existing worktree dev
  database and ran its normal startup backup/migrations; it was stopped without
  rollback. Subsequent QA uses a fresh database/settings directory and explicit
  service CLI arguments, which take precedence over dotenv. Production was not
  the target. Do not rely on environment-only isolation for this debug service.

### Decisions that must not be invented by implementation

- Official GitHub owner/repository and catalog/blocklist discovery URLs.
- First supported public platform matrix and executable isolation policy.
- Inclusion of themes in the first public marketplace.
- Monitored security contact, incident owner and protected signing environment.

Source ownership remains a human/GitHub review decision, not something a JSON
schema can prove. Package identity and publication state remain separate from a
local project's `authoring_target` and `plugin_id`.

## Decision and scope

Accepted on **2026-09-11**. Ship an in-app marketplace for code-backed ACP provider
connectors using GitHub only. The parent strategy is [Plugin Strategy](./PLUGIN_STRATEGY.md).
This document is the authoritative delivery checklist, not a claim that public
publishing or the marketplace UI has shipped.

- Authors own their source repositories and releases.
- A public Cadencr registry accepts metadata/version submissions through PRs.
- Cadencr mirrors approved package bytes into GitHub Releases under its control.
- A protected GitHub Actions workflow publishes the signed index and blocklist.
- Cadencr discovers versions from that index and installs through its existing
  managed-provider backend. No GitHub account/token is required for consumers.
- No S3, dedicated marketplace server, publisher accounts/upload portal, required
  website, arbitrary registry sources, or automatic installation of updates in V1.
- Themes, custom tabs, declarative UI plugins, skills/MCP helpers and ACP v2 are
  not prerequisites. Providers do not gain general-purpose UI extension powers.

Repository names and final URLs remain to be chosen; examples are not deployed
infrastructure. Start with a public registry repository that also owns distribution
Releases; split metadata and artifact repositories later only if necessary.

## Historical code baseline checked on 2026-09-11

Read-only inspection of worktree HEAD `8a2141ab8`; no new live-app validation or
external GitHub repository audit was performed for this documentation change.

| Area                           | Evidence and current boundary                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local creation                 | `ProviderDevelopmentCard.tsx` and `CreateProviderWorkspaceDialog.tsx` wire **Add provider** to the workspace API. `providers/development/workspace.rs` creates the ordinary project and descriptor. It does not implement the author's connector for them. |
| Local runtime                  | `providers/installed/adapter.rs` loads code-backed providers; model discovery and ACP execution are generic. Registration remains restart-gated.                                                                                                           |
| Managed installation           | `providers/installed/managed/routes.rs` accepts an exact provider/version plus `SignedManagedProviderIndex`; inventory, update, rollback, enable/disable, remove and blocklist refresh routes exist. Inventory is not a remote marketplace catalog.        |
| Trust                          | `managed/trust.rs` verifies the canonical signed payload against host-pinned Ed25519 trust; an empty keyring refuses installation.                                                                                                                         |
| Revocation                     | `managed/blocklist.rs` and `managed/blocklist/cache.rs` implement a pinned HTTPS source, verified bounded cache, expiry and monotonic publication checks.                                                                                                  |
| Still missing in this checkout | Public publication workflow and in-app marketplace browsing/index acquisition. Existing workflows are CI, CodeQL and desktop release; production marketplace configuration is not wired into the inspected desktop release workflow.                       |
| Known follow-up                | Resume-persistence eligibility still reads adapter-shared `InstalledAcpCapabilities`; isolate it per negotiated session before distribution.                                                                                                               |

Full package rules remain in [Provider Package](./PROVIDER_SPEC/PROVIDER_PACKAGE.md).
Do not invent a parallel unsigned catalog/package contract or relax the current
signature, archive, launch-integrity or conformance checks for GitHub.

## Hosting and data ownership

| Data                                             | Owner and location                         | Rule                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Source, tests, native setup instructions         | Author repository                          | Pin the source revision for every submission; retain license and provenance.                                                          |
| Identity, maintainers, approved version metadata | Cadencr registry Git history               | PR review; authors need no direct write access.                                                                                       |
| Approved platform archives                       | Cadencr-owned GitHub Release assets        | Copy exact reviewed bytes; verify SHA-256 before and after publication. Never store binaries in Git or overwrite an existing version. |
| Signed index snapshots                           | Cadencr-owned versioned publication assets | URLs in signed packages reference the final mirrored assets; sign only after those assets are available.                              |
| Signed blocklist snapshots                       | Cadencr-owned versioned publication assets | Publish independently of plugin releases, including an initial empty policy; renew before expiry.                                     |
| Current publication discovery                    | Stable official GitHub-hosted locations    | Define separate index and blocklist discovery locations; never let an arbitrary package release become the catalog's `latest`.        |

Avoid GitHub Packages, LFS and temporary Actions artifacts as the end-user package
store. The aim is zero hosting spend with public repositories and standard hosted
runners, not a permanent pricing/SLA guarantee. GitHub documents free standard
Actions for public repositories and no total release-size/bandwidth limit;
individual asset limits and service policies still apply. Review and incident
response still cost maintainer time. Sources: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Contribution and publication flow

1. The author creates a connector locally using the existing project generator
   or a documented template and implements `version`,
   `models --format acp-config-options-v1` and `run --protocol acp-v1`.
2. They test it in Cadencr, build exact-version packages for declared platforms,
   and publish them in their repository's Releases.
3. They submit a metadata PR: identity, maintainer ownership, source commit/tag,
   version, compatibility, platforms, archive URLs/checksums, license, setup
   documentation and change summary. No source-code merge into Cadencr is needed.
4. Unprivileged CI validates the schema and packaging. Executable probes run in
   disposable isolated jobs without publication secrets or write credentials;
   do not execute PR code in a privileged `pull_request_target` context.
5. A maintainer reviews every executable version, including code/dependency
   changes and provenance. Protocol conformance is not a safety certification.
6. After approval, a separate protected publisher revalidates the approved
   identity/version/digests, copies exact bytes to Cadencr Releases, verifies
   their availability, builds the existing canonical index and signs it.
   The signing job never executes contributor code; scope credentials minimally.
7. Publish the versioned index, then advance its discovery location. Serialize
   concurrent publications; retries must be idempotent and refuse conflicting
   bytes for an existing identity/version. Failed publication leaves the last
   good index usable and never advertises a missing artifact.
8. The app refreshes the index and offers the new version. Download and install
   remain host-verified and user-initiated. Each later version repeats this flow.

## Deferred public-distribution implementation sequence

- [ ] **R1 — Close runtime release gates.** Fix session-scoped resume eligibility
      with opposing-capability concurrent-session tests. Decide and document required
      OS isolation on each supported platform; subprocess cleanup is not a sandbox.
- [ ] **R2 — Establish registry governance.** Choose repository/URLs and supported
      platforms; add schema fixtures, PR template, `CONTRIBUTING.md`, maintainer/ID
      reservation and transfer rules, license requirements, security contact and
      takedown policy. No portal or broad plugin API is required.
- [ ] **R3 — Provide external author tooling.** Publish a first-connector guide,
      reference examples, repeatable packaging and reusable unprivileged conformance
      CI. Document native CLI setup/authentication; credentials never enter packages.
- [ ] **R4 — Implement protected publishing.** Mirror artifacts, canonicalize/sign
      the existing envelope, retain provenance and signed snapshots, serialize
      publication and test interrupted/repeated/conflicting submissions. Public PR
      checks and signing must be separate trust domains.
- [ ] **R5 — Provision production policy.** Wire
      `CADENCR_MANAGED_PROVIDER_KEY_ID`,
      `CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64` and
      `CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL` into release builds. Private keys stay
      outside the app and source tree. Document rotation and compromise recovery;
      the current compile-time pin means a replacement trust root needs an app
      delivery strategy, not just a new signed index.
- [ ] **R6 — Add official catalog acquisition.** Fetch/cache the official index
      through the service, verify before exposing entries, and bridge to existing
      install/update APIs. Define endpoint, size/time bounds, refresh cadence and
      stale/replayed catalog policy; index signature verification alone is not a
      freshness check. Avoid per-plugin GitHub API polling. Test HTTPS redirects,
      rate limiting, missing assets and offline cache behavior without user tokens.
- [ ] **R7 — Deliver the in-app marketplace.** Browse/search/details and exact
      version installation/update, enable/disable/remove, history and diagnostics.
      Distinguish installable, installed, currently active, next-restart state and
      quarantine. Show loading/errors and native CLI prerequisites. Do not rebuild
      the already-existing local authoring flow or bypass backend authority.
- [ ] **R8 — Operate revocation.** Assign an incident owner; automate blocklist
      renewal and monitor expiry/publication failures. Distinguish delisting from
      execution revocation. Define bounded refresh, durable disable/notification
      and running-session handling; startup/launch checks alone do not terminate
      an already-running revoked connector. Preserve transcripts and history.
- [ ] **R9 — Prove the public lifecycle.** An external author submits a real
      independently released connector; a packaged app on every supported platform
      installs it, selects a model, completes a turn, restarts/resumes when supported,
      updates, explicitly rolls back, disables and removes it without data loss.
      Also exercise tampering, revocation, expired/unavailable policy, interrupted
      publishing and absence of trust configuration. Open the beta only after these
      gates and the OS-isolation decision pass.

R2–R4 can progress alongside R1. UI design may progress early, but public
executable distribution cannot bypass R1, R5, R8 or packaged-app validation.
Canonical-event cleanup and built-in control migration remain separate work.

## Acceptance and later evolution

Success: an external developer publishes from their own repository by metadata
PR; an ordinary user installs, uses and updates that connector inside Cadencr
without editing Cadencr source, cloning the connector or obtaining a GitHub token.

A web storefront may later render the same index. S3 or another artifact store
may later replace Release URLs without redesigning the connector contract.
Publisher portals, alternative registries and other content types require their
own decisions; none are implied by this V1.
