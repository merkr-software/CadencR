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

| Step | Deliverable                                                          | State                                                                                                             |
| ---- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A    | Strict source/version submission contract and governance             | Local contract implemented and reviewed; official repository, platform and isolation policies remain open         |
| B    | Reproducible author packaging, guide and conformance workflow        | Local packer and guide implemented/reviewed; reusable conformance workflow and platform certification pending     |
| C    | Registry bootstrap and unprivileged contribution CI                  | Local immutable contribution gate and isolated CI template implemented; deployment and live GitHub checks pending |
| D    | Protected mirroring, signing and idempotent publication              | Not implemented                                                                                                   |
| E    | Publish first/new version from a marked Cadencr project              | Not implemented                                                                                                   |
| F    | Production URLs, trust roots, policy renewal and catalog integration | Backend foundation exists; production configuration absent                                                        |
| G    | In-app browsing, installation and installed-version management       | Not implemented                                                                                                   |
| H    | Revocation operations and incident recovery                          | Backend foundation exists; operational policy absent                                                              |
| I    | External-author and packaged-app lifecycle on supported targets      | Pending                                                                                                           |

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
