# Marketplace — GitHub-only distribution

The in-app marketplace distributes providers (ACP connectors), themes, custom
tabs, multi-export plugins and language servers. It runs entirely on public
GitHub repositories: no S3, dedicated server, publisher portal or required
website. Consumers need no GitHub account or token. The parent strategy is
[Plugin Strategy](./PLUGIN_STRATEGY.md); package contracts are in
[Provider Package](./PROVIDER_SPEC/PROVIDER_PACKAGE.md),
[Custom Tabs](./CUSTOM_TABS.md) and [Multi-export plugins](./MULTI_EXPORT_PLUGINS.md).

Operations (build variables, activation, revocation, key custody and rotation)
live in [Marketplace release configuration](./MARKETPLACE_RELEASE_CONFIG.md) and
the registry [operator runbook](../tooling/marketplace-registry/OPERATIONS.md).
Authors follow [AUTHORING.md](../tooling/marketplace-registry/AUTHORING.md).

## Principles

- Authors own their source repositories and releases.
- The public registry, [`merkr-software/cadencr-registry`](https://github.com/merkr-software/cadencr-registry),
  accepts metadata and version submissions through pull requests.
- A protected publisher mirrors the exact approved bytes into registry-owned
  GitHub Releases, then signs and publishes the catalog and revocation policies.
- The app discovers versions from that signed catalog and installs through the
  managed install backends. Install and update are always user-initiated.
- Versions are immutable: a conflicting change to a published identity/version
  fails closed.
- No arbitrary registry sources and no automatic update installation.

## Package kinds

| Kind      | Contract                                                                                                       | Notes                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Provider  | Executable ACP connector (`version`, `models --format acp-config-options-v1`, `run --protocol acp-v1`)         | Per-platform archives; native CLI setup and authentication stay the user's job.  |
| Theme     | Declarative `theme.json` tree                                                                                  | Platform-neutral.                                                                 |
| Tab       | Isolated web UI, optionally with a native backend ([protocol](./TAB_BACKEND_PROTOCOL.md))                      | Native backends need per-platform executables and explicit execution consent.    |
| Plugin    | One release combining several of the kinds above                                                               | Each member keeps its own installer, receipts, consent and revocation.           |
| LSP       | Prepared language-server archive                                                                               | Requires the optional LSP revocation policy; minimum app version `0.16.1`.      |

There is no fixed platform matrix: each provider and native tab declares its own
OS/architecture targets, and the client hides packages without a build for the
current platform.

## Trust model

- **Two levels.** An offline Ed25519 root key (`cadencr-root-1`) signs trust
  generations that delegate catalog and policy signing to one online key
  (`cadencr-registry-1`). The root private key never touches a runner or the
  repository. Public material is in [marketplace-trust](./marketplace-trust/README.md).
- **Freshness.** The catalog and each revocation policy (provider, theme, tab,
  LSP) are signed with a validity window of at most 14 days. A scheduled
  renewal-only workflow re-signs unchanged content; a daily expiry watch fails
  when less than 72 hours remain.
- **Revocation.** Revocation policies are published independently of package
  releases. Delisting and execution revocation are distinct; an authenticated
  cached policy keeps blocking what it lists even after it expires.
- **Retirement and handoff.** Append-only signed records retire a provider's
  versions and assign its identity to a successor, on the separate
  `marketplace-v2-admin` channel; see [provider ownership handoff](./PI_PROVIDER_HANDOFF.md).
- **Official publisher.** `cadencr` is reserved: packages outside the official
  `merkr-software` repositories cannot claim it.
- **Compatibility.** The first marketplace-compatible desktop release is `0.15.0`
  (`min_app_version`).
- **Security contact.** GitHub private vulnerability reporting on the registry.

The desktop pins the trust root and feed URLs at compile time; a build without
them (dev builds, forks) shows the marketplace as unavailable.

## Hosting and data ownership

| Data                                             | Owner and location                         | Rule                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Source, tests, native setup instructions         | Author repository                          | Pin the source revision for every submission; retain license and provenance.                                                          |
| Identity, maintainers, approved version metadata | Registry Git history                       | PR review; authors need no direct write access.                                                                                       |
| Approved platform archives                       | Registry-owned GitHub Release assets       | Copy exact reviewed bytes; verify SHA-256 before and after publication. Never store binaries in Git or overwrite an existing version. |
| Signed catalog and policy snapshots              | Registry-owned versioned publication assets | Sign only after the referenced archives are available.                                                                                |
| Current discovery                                | `marketplace-v2` branch of the registry    | Separate catalog and policy files; an arbitrary package release never becomes the catalog's `latest`.                                 |

GitHub Packages, LFS and Actions artifacts are not used as the end-user package
store. GitHub is transport and storage, not a replacement for Cadencr signatures,
checksums or revocation policy.

## Contribution and publication flow

1. The author builds and tests the package locally in Cadencr (plugin projects,
   `cadencr` CLI), then publishes exact-version archives in their own Releases.
2. They open a registry PR with identity, maintainers, source commit/tag, version,
   compatibility, platforms, archive URLs/checksums, license and change summary.
3. Unprivileged CI validates schema and packaging. Executable probes run only in
   disposable jobs without secrets; PR code never runs in a privileged context.
4. A maintainer reviews every executable version. Protocol conformance is not a
   safety certification.
5. After merge, the protected publisher revalidates identity/version/digests,
   mirrors the bytes, builds the canonical catalog and signs it. The signing job
   never executes contributor code.
6. The versioned catalog is published, then discovery advances. Publications are
   serialized; retries are idempotent and a failed publication leaves the last
   good catalog usable.
7. The app refreshes the catalog and offers the new version.

## Tooling

- **`cadencr` CLI** (`packages/cli`): validation, packaging, signing, author
  publication and registry operations. Released independently under
  `cli/vX.Y.Z` tags; the registry template pins the qualified release in
  [`ci/released-cli.env`](../tooling/marketplace-registry/ci/released-cli.env).
  A new CLI behavior change needs a new immutable release before any pin moves.
- **Shared Rust libraries**: `packages/registry-core` (contracts, plugin packages,
  submissions) and `packages/registry-publisher` (mirroring, signing, recovery).
  They are the only business implementation; registry CI is thin orchestration.
- **Registry template**: `tooling/marketplace-registry` (contribution CI,
  protected publication, renewal and expiry-watch workflows).
- **Official plugin sources**: [`plugins/`](../plugins/README.md), released through
  [`plugins/RELEASING.md`](../plugins/RELEASING.md).
- **Desktop/service**: the shared core (signed catalog and its verified cache,
  guarded downloads, private storage, signed revocation feeds) is
  `domain/marketplace`; each kind's installer, receipts and policy live next to
  it (`providers/installed/managed`, `themes/managed`, `plugin_tabs/managed`,
  `lsp/managed`); the UI is the `/marketplace` route.

## Open gates

- Packaged-client consumer QA on every supported platform (Linux included):
  install/update/restart/remove for each kind, native-tab consent and lifecycle,
  tampering, revocation, expired/offline policies and rollback.
- Native conformance of each executable on its own host; Linux runner checks do
  not qualify macOS binaries.
- A third-party author's initial submission and immutable update, end to end.
- An explicit OS-isolation decision for marketplace executables (see
  [Plugin Strategy §6](./PLUGIN_STRATEGY.md#6-security-invariants)).
- LSP entries stay out of the production catalog, and
  `CADENCR_MANAGED_LSP_BLOCKLIST_URL` stays unset, until the `v0.16.1` cutover.

## Later evolution

A web storefront may render the same catalog. Another artifact store may replace
Release URLs without changing package contracts. Publisher portals, alternative
registries and other content types each need their own decision.
