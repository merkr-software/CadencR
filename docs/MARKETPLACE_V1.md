# Marketplace V1 — GitHub-only distribution

## Execution update — 2026-09-20

Marketplace implementation is now authorized, following the local-plugin work.
This does not change the published v0.12.0 scope or authorize a remote repository,
release, push, registry publication, or production-data changes.

The first implemented distribution contract remains **ACP providers**. Theme
projects already carry authoring identity, but theme distribution requires its own
contract; including themes in the first public marketplace is awaiting confirmation.

### Registry destination and contribution policy — accepted 2026-09-20

- Official contribution destination: `merkr-software/cadencr-registry`.
- Authors contribute through a personal fork, dedicated branch and pull request;
  the app must never push directly to the upstream default branch.
- Every remote submission requires an explicit in-app confirmation of the reviewed
  destination, connected account and exact contribution. Preview is read-only.
- Registry CI validation and maintainer approval remain required before publication.
  Opening a PR is not registry acceptance, merge, signing or publication.
- This decision authorizes implementation, not creation of the real repository or
  live test PRs. Deployment, repository protections and live GitHub QA remain gates.
- The registry PR preparation/submission increment is implemented locally. Its
  verification and delivery boundaries are recorded below.

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

| Step | Deliverable                                                          | State                                                                                                                                     |
| ---- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Strict source/version submission contract and governance             | Local contract implemented and reviewed; official repository, platform and isolation policies remain open                                 |
| B    | Reproducible author packaging, guide and conformance workflow        | Local packer and guide implemented/reviewed; reusable conformance workflow and platform certification pending                             |
| C    | Registry bootstrap and unprivileged contribution CI                  | Local immutable contribution gate and isolated CI template implemented; deployment and live GitHub checks pending                         |
| D    | Protected mirroring, signing and idempotent publication              | Operator pipeline, published-state recovery and protected workflow template implemented locally; deployment pending                       |
| E    | Publish first/new version from a marked Cadencr project              | E1-E3 and E4 local contribution export implemented/reviewed; registry PR automation implemented locally; live deployment/QA remains gated |
| F    | Production URLs, trust roots, policy renewal and catalog integration | Backend foundation exists; production configuration absent                                                                                |
| G    | In-app browsing, installation and installed-version management       | Not implemented                                                                                                                           |
| H    | Revocation operations and incident recovery                          | Backend foundation exists; operational policy absent                                                                                      |
| I    | External-author and packaged-app lifecycle on supported targets      | Pending                                                                                                                                   |

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
  the identified findings. E1 is committed locally as `8e28eb005`; no push.
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

### Local provider bundle preparation increment (E2) — 2026-09-20

- Marked provider projects can prepare a local archive and managed `package.json`
  from explicitly supplied metadata, one binary target and an author-reviewed
  staging directory. Existing projects are not reclassified. Themes still need
  a separate distribution contract.
- The POST endpoint is authenticated and loopback-only, absent from the shared
  remote router. It verifies the durable project/plugin identity and reuses the
  managed package validator. Target choices come from the backend contract through
  the existing readiness response, not a second frontend list.
- Staging must be absolute, outside the project tree and not the home directory
  itself. Symlinks, special files, invalid/nonportable names, case collisions and
  common secret-prone filenames are rejected. Declared executable/assets must be
  present; non-Windows entrypoints must be executable. This is trusted, quiescent
  staging, not an OS sandbox or secret-content scan.
- The app runs a Rust streaming deterministic tar/gzip writer, with no runtime
  Node requirement or connector/build/Git/network execution. Installer limits are
  reused: 4,096 entries, 512 MiB expanded, 256 MiB per file and compressed output.
  Source snapshots are checked before/after writing. Reproducibility is within
  the same runtime; equality with the Node CLI's compressed bytes is not promised.
- Outputs use exclusive creation in a new app-owned UUID directory and update only
  the selected target SHA-256 in the preserved metadata. Inputs and source Git
  state remain unchanged. Output paths, digest, size and target are shown in the
  UI; errors and pending state are explicit. No upload, release, registry PR,
  signing, conformance approval or publisher verification occurs.
- Preparations are serialized off the async executor. A global 16-bundle cap
  refuses further writes with the storage path and manual cleanup instructions;
  previous successes are never automatically deleted. The scan is also bounded
  to 256 project directories. Disconnecting does not cancel accepted work: it may
  finish and retain an output within that same quota.
- Three GPT-5.6-Sol reuse/quality/efficiency reviews completed, followed by parent
  corrections: bounded directory enumeration, root-symlink and UTF-8 handling,
  storage quota, moderate compression, nonblocking validation and shared target
  choices. The home restriction was clarified rather than banning all staging
  directories located beneath a user's home.
- Live dev QA uses fresh `/tmp` data with explicit service CLI isolation, a
  dedicated frontend and temporary browser profile. Consent gating, real bundle
  creation, stale-result clearing, JSON errors, quota errors and ordinary-project
  absence pass. Authenticated API checks verify identity/path/secret rejection,
  repeatability, digest/metadata preservation and refusal at 16 retained bundles.
  No provider executable is launched. Browser-only desktop-bridge/CSP warnings
  and a development WebSocket reconnect warning were observed; no new UI exception.
- Verification: 11 packaging Rust unit tests (including the managed installer
  extraction path), 6 readiness regression tests, and one authenticated-route
  integration test with the real Node registry validator pass. The full desktop
  suite passes 4,932 tests. Workspace lint, desktop typecheck/Knip, formatting and
  diff checks pass; Turbo emitted sandbox cache-I/O warnings, not lint failures.
  QA-owned processes are stopped and the temporary database/artifacts preserved.
  These are local/dev proofs, not packaged-app or live GitHub/Actions acceptance.
  Local commit approved; no push or remote publication is authorized.
- Next E4: create the registry contribution from the published author release.
  Multi-target metadata assembly remains separate from E2/E3.
  Official registry deployment/credentials, real GitHub/Actions QA, themes,
  marketplace browsing and supported-platform packaged QA remain open gates.

### Confirmed author GitHub release increment (E3) — 2026-09-20

- A marked provider project can review and publish its one-target E2 bundle to an
  existing public GitHub repository. The repository must be the project's clean
  local `origin`; the release tag must already exist remotely and resolve to the
  same commit as local `HEAD`. E3 does not create a repository or tag, push source,
  assemble multiple targets, sign a catalogue, or submit a registry contribution.
- Review is an explicit, non-mutating request. It reloads the server-owned bundle,
  validates its managed metadata and archive digest, inspects the connected GitHub
  actor, repository identity and tag commit, and returns the exact release plan.
  The preview fingerprint binds the actor, immutable GitHub repository ID, source
  commit, package metadata and archive digests, target/version, release notes and
  publication policy. Publishing requires a separate confirmation of that exact
  fingerprint; any changed input or remote identity requires a fresh preview.
- Publication creates or reconciles a draft release and uploads exactly two assets:
  the provider archive and `package.json`. It never replaces or deletes an existing
  asset or overwrites a conflicting release. Existing release fields, asset names,
  sizes and GitHub-reported `sha256` digests must match before a retry can continue;
  absent GitHub digests fail closed. This digest check relies on GitHub's reported
  asset digest and is **not** an independent public re-download of uploaded bytes.
- Ambiguous create, upload and publish responses are reconciled against the exact
  confirmed state. Exact completed publications are safe no-write retries; foreign,
  duplicate, incomplete published releases or changed state are refused rather than repaired
  destructively. The actor, repository ID and tag commit are revalidated during
  publication, including immediately before promotion from draft.
- GitHub API and upload hosts are fixed HTTPS origins, credentials are never sent
  across redirects, and redirects are disabled. Request bodies, release notes,
  repository/tag/asset segments, local bundle files, GitHub response bodies,
  pagination, annotated-tag depth, operation concurrency and network timeouts are
  bounded. Local files are opened without following symlinks and checked for
  replacement while read.
- Verification: 29 publication unit tests, three bounded Git-runner tests, the
  authenticated/local-only route integration test, and 4,946 desktop tests passed.
  Isolated `pnpm dev` QA exercised a real prepared bundle, missing authentication,
  dirty-source refusal/recovery, invalid inputs, explicit confirmation refusal,
  visible loading, and disabled controls. The positive GitHub mutation/retry path
  is covered by localhost HTTP fixtures, not a real GitHub release. No live GitHub
  repository was mutated, and no source push, tag creation or registry PR occurred.
  The frontend uses a narrowly scoped 190-second timeout, verified in the live
  request, above the backend's 180-second bound. Lint, type checking, unused-code
  checks, Rust check and formatting passed. Changes await local commit approval.
- Rechecks are not an atomic transaction with external GitHub editors. Protect
  release tags and assets against concurrent changes; no historical deletion
  ledger, source-to-binary provenance or connector conformance is established here.
- E4 local contribution export is described below. Official registry
  deployment/signing, live GitHub/Actions acceptance, multi-target publication,
  themes, marketplace browsing and packaged-platform certification remain separate
  gates.

### Local registry contribution export increment (E4) — 2026-09-20

- From an explicit E3 preview, the author can separately confirm local contribution
  file creation and read-only GitHub verification. The authenticated POST reloads
  the app-owned bundle, project/source state and GitHub identity, then recomputes
  the E3 plan fingerprint. Changed inputs, actor, immutable repository identity,
  source commit or tag require a fresh release preview.
- Before writing locally, E4 performs GET-only verification that the exact release
  is already published rather than a draft and that its two assets still match the
  expected names, sizes and native GitHub-reported `sha256` digests. It does not
  publish or mutate the release and does not independently download asset bytes.
- The generated submission uses the existing exact `provider-submission-v1`
  envelope: schema version, preserved managed package object, source repository,
  commit and tag, plus release notes as the changelog. Unknown package metadata is
  preserved. The same marketplace submission delta rules validate required
  license/assets, repository/source consistency, supported binary-only distribution,
  safe identifiers/tags and reserved built-in provider IDs. No local-only draft
  schema is introduced, and the desktop runtime does not require production Node.
- Each attempt requires a fresh explicit confirmation and creates a fresh UUID
  directory beneath the settings sibling
  `provider-publication-contributions/<project-id>/`. It contains
  `packages/<provider-id>-<version>.json`, the paired
  `submissions/<provider-id>-<version>.json`, and `PULL_REQUEST.md`. The Markdown
  records generated facts while leaving ownership, credential review, conformance,
  licensing/provenance and official CI assertions unchecked for humans.
- Writes use a fresh app-owned UUID directory and exclusive file creation; existing
  files are never overwritten. Ordinary write failures attempt bounded cleanup, but
  process interruption can leave a partial UUID directory that counts toward the
  quota and requires manual inspection/removal. At most 16 exports are retained
  globally and nothing is automatically deleted. Every successful action gets a
  new UUID and is not an idempotent replay to a prior output directory. Archive any
  contribution that must be retained before manually removing it from app storage.
- This is a local export, not registry submission. No official registry destination
  is configured, so E4 does not fork a repository, create a branch, push, open a
  pull request, sign content or claim registry acceptance. Without the authoritative
  registry baseline it also cannot prove whether this is the first version or
  validate continuity against already-published provider versions; official registry
  CI and maintainer review remain required.
- Verification: 4,954 desktop tests, 40 targeted Rust publication tests, the
  authenticated/local-only route integration test and the Node registry suite pass.
  Generated contributions pass the existing Node validators; desktop types, lint,
  unused-code checks and service compilation pass. Independent reuse, quality and
  efficiency reviews were completed and their scoped corrections integrated.
- Isolated dev QA exercised real API authentication, confirmation, project/UUID,
  notes-size, unknown-field and missing-GitHub-auth rejection with no export created.
  Browser QA used a simulated E3 preview only; E4 requests reached the real isolated
  service. Loading/fieldset locking, consumed confirmation, visible auth failure,
  fresh retry consent, 190-second timeout and stale-preview clearing were checked.
  Positive GitHub/export behavior remains fixture-tested, not live GitHub QA or an
  export produced through the app. No production data or GitHub state was changed;
  QA processes were stopped and the isolated database retained. Git delivery is
  separate from this verification.
- The registry destination and fork/branch/PR policy are now accepted above.
  Remote PR automation is the next implementation increment; official deployment
  and live acceptance remain separate gates.

### Registry pull-request automation increment — 2026-09-20

- Fixed destination `merkr-software/cadencr-registry`; local authenticated preview
  and submit endpoints reload the immutable bundle and verify its published author
  release. They do not trust edited local contribution exports.
- The read-only preview binds exact paired documents and PR body, connected account
  and numeric identity, registry numeric identity and pinned default-branch commit.
  Every submit recomputes the plan and requires fresh explicit confirmation.
- The app creates or verifies the personal fork, writes both metadata blobs in one
  tree/commit, verifies the candidate before creating a deterministic new branch,
  and opens a PR. Existing exact branches/open PRs may be reused; foreign state,
  closed PRs and upstream base drift fail closed. No force update, overwrite,
  branch deletion, upstream push, merge, signing or registry publication occurs.
- Base and candidate Git tree modes are checked independently of GitHub Contents
  responses. Maintainer branch mutation is not granted by the created PR. Changes
  require another reviewed plan, not silent branch rewriting.
- All HTTP destinations are fixed, redirects disabled, responses bounded to 2 MiB,
  polling and operation time bounded. A single transport retains its connection
  pool, archive buffers are released before remote verification, and exact PR body
  bytes are shared rather than copied. Rate-limit errors are distinguished from
  ordinary permission rejection when GitHub exposes rate-limit headers.
- Interrupted/failed requests can leave a fork, unreachable Git objects, a branch
  or a PR. There is no automatic destructive cleanup. Inspect remote state before
  retrying with fresh consent; exact readback is required for reuse. GitHub changes
  by other actors are not transactional with these checks. A changed upstream base
  requires another preview and can produce a new branch; old branches/PRs are not
  automatically deleted, rebased or closed.
- Trusted registry CI remains authoritative for cross-version identity/ownership
  continuity, full catalog policy and maintainer review. Opening a PR is not proof
  of acceptance, source-to-binary provenance or provider conformance.
- Three GPT-5.6-Sol finish-job reviews and the parent correction/re-review loop
  completed. The desktop suite passes 4,961 tests; 55 targeted Rust publication
  tests pass, including scripted no-write rejection and lost-response cases.
  Isolated live dev QA exercised actual authenticated API rejection paths and the
  real registry preview/submit missing-auth errors. UI preview prerequisites were
  explicitly simulated to check consent consumption, sibling locking, loading,
  error recovery, the 190-second timeout and stale-plan clearing. Positive GitHub
  mutations remain fixture-tested only; no real fork, branch or PR was created.
  QA-owned processes were stopped, the new QA database retained, and production
  data untouched. The authenticated/local-only route integration test, service
  compilation, desktop types/lint/unused-code checks, formatting and Node registry
  integration tests also pass. Changes remain uncommitted pending approval.
- Official repository provisioning, branch protections, CI deployment and a real
  GitHub end-to-end run remain separate gates, not performed by this increment.

### Official registry provisioning — 2026-09-20

- User authorized provisioning `merkr-software/cadencr-registry`, CI/protections
  and real GitHub QA. The public repository now exists (GitHub numeric ID
  `1378674060`), initially empty. Private vulnerability reporting is enabled;
  Actions is explicitly disabled until the reviewed bootstrap is delivered.
- Standalone bootstrap is prepared from Cadencr `ca2cb8705`, with LICENSE,
  provenance, no live demonstration packages, tracked empty packages/submissions,
  CODEOWNERS, pinned validation actions and inactive publication workflow examples.
  Three GPT-5.6-Sol reviews completed; documentation/install issues were corrected.
- Standalone testing exposed an undeclared `yaml` test dependency. The source
  template now declares exact `yaml@2.9.0` with a lockfile. Only the isolated
  candidate-tooling CI job runs `npm ci --ignore-scripts --no-audit --no-fund`;
  trusted inert metadata validation still installs no candidate dependencies.
- The staged standalone bootstrap passes all 250 tests and empty registry
  validation. Source-template tests are checked separately. These are local
  checks, not proof of deployed Actions or branch protections.
- Bootstrap commit/push, main-branch protections and two temporary fork QA PRs
  (closed without merge) have been proposed for explicit delivery approval.
  Until delivered, no default-branch content, CI run, fork PR, release, signing key
  or production catalog has been provisioned by this increment.

### Next step — shared Rust `cadencr` CLI (approved, implementation started)

- Decision: maintain the CLI and its shared Rust libraries exclusively in this
  monorepo. The public registry owns metadata, contribution documentation and
  thin workflows, not a second implementation of the tooling.
- This replaces the JavaScript-to-TypeScript/Rust decision step, before resuming
  GitHub operational QA and before enabling signing/publication workflows.
- First increment: extract reusable plugin validation used by the backend and
  CLI; implement headless `cadencr plugin validate <folder>`, registry contribution
  validation and deterministic unsigned index construction. Commands must work
  without Electron, a running service, a database or executing plugin code.
- Subsequent migration increments cover archive packaging, signing, GitHub
  publication/recovery and their tests. Preserve existing wire formats,
  deterministic bytes, cryptographic contracts, bounded input handling and
  immutable base/candidate contribution checks. Do not claim parity until the
  applicable existing fixtures and negative/security cases pass against Rust.
- Build versioned CLI binaries in the monorepo release pipeline, including Linux
  for registry CI. Registry workflows consume an explicitly pinned release and
  verify its expected digest from trusted configuration, never a PR-controlled
  download URL/version or an unpinned `latest`. Registry upgrades are reviewed
  independently of desktop releases; PR checks require no publication secrets.
- Switch registry workflows only after a usable CLI release and parity checks;
  then remove superseded JavaScript implementations/tests and dependency setup.
  Until then, existing tooling remains the active implementation and parity
  oracle. JSON metadata/schemas and YAML workflows remain declarative formats.
- Deferred: `cadencr open`, `plugin add`, `plugin delete`, headless app
  `update`/`upgrade`, and unrelated desktop/backend CLI features. No unused stubs.
- Execution: parallel-advisor with GPT-5.6-Sol workers, parent integration review,
  independent finish-job review at completed steps, and applicable live checks.
  Implementation permission does not authorize commits, push, PRs or releases.
  Existing dirty changes and the deployed public registry are preserved.

### CLI increment — local implementation, not a registry cutover

- Added `packages/cli` (`cadencr`) plus `plugin-core` and `registry-core` Rust
  libraries, wired into the Cargo/pnpm/Turbo workspace. The backend re-exports
  its existing descriptor contracts from plugin-core; the former implementation
  was removed rather than retained as dead code.
- Implemented provider-only `plugin validate <folder> --descriptor <file>`.
  Existing workspaces keep their host descriptor outside the project; the
  explicit input avoids inventing a manifest convention or consulting a user DB.
  Validation never starts the provider or proves publication/runtime conformance.
- Implemented inert base/candidate registry validation and unsigned index
  construction. CLI diagnostics expose stable codes, including JSON usage errors;
  index output is published without overwriting existing files and without
  leaving a partially written destination on failure.
- Added a transitional integration harness running the existing eight JavaScript
  contribution safety scenarios against the actual Rust CLI. A separate local
  438-case package mutation comparison found four initial semver/compatibility
  gaps; after correction, an expanded 694-case corpus reports no validation differences.
- Verification so far: 21 plugin-core tests, 142 targeted installed-provider
  backend tests, 19 registry-core tests, 8 CLI subprocess tests, two injected
  output write/flush failure unit tests and one contribution-oracle integration test.
  These are local checks, not deployed GitHub Actions or a Linux release test.

### CLI follow-up — canonical output and release/CI wiring

#### Autonomous completion contract — 2026-09-20

- User approved continuing all six remaining stages without per-stage prompts:
  CLI delivery, registry activation, compatible signatures, remaining Rust
  tooling migration, removal of replaced registry JavaScript, and end-to-end QA.
- Each implementation stage uses GPT-5.6-Sol workers through parallel-advisor,
  parent integration checks, independent finish-job reviews, and automatically
  approved signed local commits with normal hooks before the next stage.
- New signatures must share one canonical format; previously valid signatures
  remain explicitly supported. This compatibility direction is now approved.
- Delivery must not incidentally publish an unrelated desktop release or expose
  private monorepo history. Validate release topology and existing version/tag
  state first. Public registry changes remain metadata/docs/thin workflows only;
  private keys and production data never become fixtures or repository content.
- Preserve the active JS implementation until replacement parity and actual
  pinned-binary delivery are established. Report external gates separately;
  local tests do not establish deployed CI or live installation acceptance.
- Release audit: the existing `v*` pipeline publishes the entire desktop app,
  not only the CLI. The current feature tip is not an authorized coordinated
  release tip, and `v0.11.5` is already consumed without a CLI asset. Do not
  reuse that tag or invent a new desktop version to unblock registry tooling.
  Continue independent migration work while actual binary publication and pin
  activation remain external delivery gates.
- First parallel migration wave implements compatible signature verification,
  archive packaging and publication planning. Independent source reviews found
  archive output/source races, duplicated service packing logic, an unchecked
  stdout write, recursion depth and eager legacy serialization. Source corrections
  are applied, including one shared CLI/service archive engine and private
  no-clobber publication. Commit acceptance follows the integrated checks below.
- Packaging assumes a trusted destination directory: private temporary output
  and no-clobber publication protect existing files, but malicious concurrent
  replacement of destination ancestors is not a directory-handle-bound sandbox.
  Such ancestry replacement remains a documented defense-in-depth limitation.
- Lockfile incident resolved after the user's explicit rollback authorization:
  the previous third-party versions are restored and only seven workspace
  dependency edges were added. The unintended `cargo generate-lockfile` refresh
  is excluded. Validation resumes with `--locked`; pre-repair targeted successes
  are not substituted for tests of the final integrated source.
- Post-repair checks: CLI/core suites pass (including 32 registry-core tests),
  86 managed-provider backend tests pass, 16 publication-package unit tests pass,
  and the real-route publication-package integration test passes. Archive parity
  compares deterministic decompressed TAR bytes; cross-implementation gzip bytes
  are deliberately not claimed identical.
- Live debug-service API QA accepts both Node-canonical and legacy signatures
  through signature validation to the expected missing-fixture download failure;
  both tampered variants fail with `REGISTRY_SIGNATURE_INVALID`. This proves the
  trust gate, not an end-to-end package installation. The initial `pnpm dev`
  launch overrode shell isolation variables from the worktree `.env` and opened
  the development database; it was stopped before API tests. The actual requests
  used explicit CLI DB/settings/port arguments and a new temporary QA database.
  Production data was not accessed, QA processes were stopped, and no database
  was deleted or restored. Release trust settings remain unchanged in source.

- CLI numeric canonicalization now matches the JavaScript oracle: input numbers
  use binary64 semantics and correctly-rounded parsing (`serde_json/float_roundtrip`),
  output uses `ryu-js` while retaining the existing UTF-8 object-key ordering.
  Deterministic differential tests cover 263 numeric inputs, including giant
  integers, negative zero, subnormals, overflow/underflow and exponent thresholds. Non-portable lone
  surrogate strings remain rejected instead of silently transformed.
- The release workflow now tests and builds the Linux CLI in a separate read-only
  job, without installing desktop/pnpm dependencies. The initial GNU Linux
  artifact targets Ubuntu 24.04 registry CI only; both consumer jobs pin that
  same runner image. Older Linux compatibility is not asserted. It packages a version-checked
  raw binary and SHA-256 manifest, transfers them with SHA-pinned Actions, verifies
  them before release preparation, and uploads them into the same draft release
  before its existing publication gate. CLI versions participate in release.sh's
  version checks; no tag or release was created by this implementation.
- Both registry required-check names are preserved. They run a thin trusted-base
  shell bootstrap with a non-executable version/digest pin file. A fully PENDING
  pin retains the current JS checks; a reviewed real pin switches both jobs to
  the downloaded CLI, never to candidate scripts. Downloads use the verified
  `merkr-software/CadencR` release location, HTTPS redirect allowlisting, bounded
  transfers, digest verification before execution and an exact version check.
  Empty registries remain valid and do not attempt to create an empty catalog.
- Pin activation needs an actual published Linux binary and its digest, followed
  by a reviewed registry change. No invented release version or checksum has
  been committed into the configuration; both pins remain PENDING.
- Signature compatibility is now implemented and committed: shared canonical
  bytes are preferred, with explicit legacy verification and exact verified-byte
  receipt hashes retained. The service trust-gate QA above covers both formats.
- Local verification includes the CLI/core suites, the existing contribution
  oracle, the 263-case numeric oracle, release packaging/version/overwrite tests,
  and offline trusted-download/cutover tests. A native binary packaging smoke
  passed. These are not claims of a live Linux runner or deployed GitHub QA.
- Final registry suite: 252 tests passed after installing its locked test-only
  dependency and allowing loopback HTTP fixtures outside the sandbox. Installed
  provider regression tests: 142 passed. Rust formatting, release packaging
  failure/retry tests and release workflow checks passed.
- Final independent reuse/quality/efficiency review consolidated argument
  validation, removed a full metadata clone during credential inspection, and
  added released-download redirect and wrong-version regression coverage.
- The separate public-registry checkout has the matching local workflow,
  bootstrap, pin file and tests prepared; its focused checks pass and the changed
  content was scanned for sensitive information. No commit, push, PR or release
  was performed, and no production database was touched.
- Remaining delivery gates: publish and pin the CLI from an authorized release,
  run real GitHub CI, then remove superseded JS from the public registry.
  Packaging and signature compatibility are locally committed. The next Rust
  migration covers signing and verified staging, followed by mirroring,
  promotion, catalog publication/discovery and recovery. Active JS must remain
  until parity and replacement delivery, then the public lifecycle QA can close.

### Rust signing and verified staging increment — 2026-09-20

- Added `registry sign-index`, `verify-index`, `assemble-signed-index` and
  `stage-publication`. Offline validation/signing remains in registry-core;
  bounded network acquisition is isolated in registry-publisher and is not a
  service/database dependency. CLI dispatch is split into focused modules.
- Ed25519 signing preserves Node-compatible canonical bytes and envelope shape.
  Keys are bounded no-follow local PEM inputs; private PEM/DER buffers are
  zeroized. Whole-second UTC timestamps and omitted empty optional fields are
  enforced for signing/verification. Assembly validates structure only; it is
  not authentication. Rust deliberately rejects impossible calendar dates that
  the old JavaScript assembly parser can normalize.
- Review found and corrected reserved binary argument drift: Rust now matches
  the runtime host and actual JavaScript oracle, including `run`, `acp-v1` and
  `--`. Differential CLI tests cover reserved tokens, flag prefixes and safe
  near-prefix controls.
- Staging retains the deterministic plan/receipt contract, at most six targets,
  256 MiB streamed archive limit, SHA-256 verification and immutable publication.
  Downloads use allowlisted HTTPS redirects without contributor credentials;
  locks/partials use ownership checks, and retries revalidate existing artifacts.
  Conflicting bytes, symlinks, FIFOs and foreign file replacements are refused
  or preserved rather than overwritten. Staging directories must be trusted;
  this is not protection against arbitrary concurrent ancestor replacement.
- Local verification: 32 registry-core tests, 21 plugin-core tests, 12 publisher
  tests and 28 CLI tests pass, including actual Node signature/staging oracles
  and real CLI replay/tamper checks against inert local artifacts. All-target
  Clippy passes for CLI/core/publisher. Release job tests now include publisher,
  and workspace test/check commands use `--locked`. No external dependency
  version, source or checksum changed.
- Independent finish-job review corrected stale offline-only help, deduplicated
  private output creation, reused one lazily built HTTP client per staging run,
  removed repeated payload/signature decoding and redundant third archive hashes,
  and aligned CLI verification with the service's strict Ed25519 primitive. A
  weak identity-key forgery is rejected in a real CLI regression test.
- Limits of this increment: no real GitHub/TLS publication proof, deterministic
  timeout/redirect cancellation or cleanup-I/O-failure fixture. Files are synced,
  but directory entries have no power-loss durability guarantee. If identity
  inspection fails immediately after creation, uncertain lock/partial ownership
  is deliberately retained for manual inspection rather than blindly unlinked. Mirroring,
  promotion, catalog signing/publication/discovery and recovery still use the
  retained JavaScript implementation. No registry pin was activated, no remote
  publication happened, and no database was used by these CLI checks.

### Decisions that must not be invented by implementation

- Catalog/blocklist discovery URLs and trust roots (contribution repository is decided above).
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
