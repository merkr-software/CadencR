# Independent official plugin releases

## TypeScript LSP publication — 2026-11-04

The local registry, qualification and author pins select qualified CLI `0.15.5`.
The existing approved author policy and protected `official-plugin-publication`
environment govern publication. Source, policy, account, repository identity,
exact request digest and environment protections are rechecked independently by
the inspection and publication jobs; no protection or author authority is changed.

The allowlisted `typescript-language-server` package `0.1.0` uses the separate tag
`lsp-typescript-language-server-v0.1.0`, not a desktop `v*` tag. It is prepared from
[tracked canonical payload and source lock](lsp/typescript-language-server/README.md).
The preparer verifies every locked regular file before the shared Rust CLI packs
each declared target twice and compares the result with the qualified bytes.
Neither the server nor any candidate script executes during publication.

Use the manual `official-plugin-author.yml` workflow with the actual primary
source commit, its existing exact tag, and a zero request digest for inspection.
Review the reconstructed inputs, then publish with the exact inspected digest
through the unchanged protected environment. The author job reconstructs from
Git blobs again; uploaded inspection or QA artifacts are never publication inputs.
The CLI uploads the three archives and full `package.json` metadata.

This is package publication only: minimum app `0.16.1`, production catalog LSP
admission, revocation-feed activation and application release remain distinct.
The prepared Node bundle retains both upstream license notices and requires an
existing Node.js >=20; runtime qualification used Node.js `22.19.0` on Linux,
macOS ARM and macOS Intel. Packaged-client lifecycle, native server distribution
and the minimum macOS version remain separate qualification work.

The earlier preparation notes below retain historical `PENDING` states. Current
machine policies and the package-specific source record govern this publication.

## Pi retirement — 2026-11-04

The first-party Pi source, qualification workflow and `provider-pi` release-policy
entry have been removed in favor of edjubert's independent connector. Historical
Pi evidence below describes the retired implementation. New official Pi releases
are no longer allowlisted. See [the handoff record](../docs/PI_PROVIDER_HANDOFF.md)
for the separate registry ownership and catalog publication requirements.

## Scope

- Tags: `plugins/theme-graphite/v0.1.0`,
  `plugins/theme-ember/v0.1.0`, `plugins/theme-fjord/v0.1.0`.
- Never use desktop `v*` tags. Plugin versions do not change app versions.
- `release-policy.json` records the explicit source identities, independent versions
  and reviewed blob mappings. Source templates carry full registry metadata.
- This preparation adds no tags, releases, registry entries or marketplace activation.

## Preparation contract

The trusted preparer reads candidate **Git blobs only**. It never imports, invokes
or builds a contributor script, launcher, tab bundle or provider binary. Only the
checksum-pinned released Rust CLI executes. The registry pin still identifies the
older provider/theme-qualified binary; a tab-capable replacement has not been
delivered or promoted. The separate author pin and publication policies remain
`PENDING`; there is no qualification-pin or source-build fallback in production.

`release-policy.json` schema `2` is the explicit allowlist, not tag matching:

| Field                         | Meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `plugins.<kind>-<id>`         | Exact official identity and independent source version                   |
| `source_path`, `package`      | Tracked source root and full schema-2 package template                   |
| `preparation: READY`          | Source mapping recorded; **not** legal/native/publication approval       |
| `payloads.<target>.directory` | Source root for reviewed payload blobs                                   |
| `files.<destination>`         | SHA-256 and output mode; optional source path and exact source mode      |
| `closed_directories`          | Exact runtime subtrees: extra/missing files fail rather than disappear   |
| `publication`                 | Still `PENDING`; only a separate reviewed change may approve publication |

Themes have exact closed `theme.json` trees. Historically, Pi's interpreted modules were copied
from `src/*.mjs` into `bin/`, with `provider.mjs` renamed `provider` and marked
executable; the copied launcher is **never run**. Explicit readme/license/icon
blobs are included. Author scripts, tests and dependencies are not payload.
Pi's recorded arm64 candidate does not assert native or production qualification.
Changing a mapped byte or source mode requires a reviewed policy digest update.

Custom tabs use the same mechanism with **already compiled**, reviewed tracked
web assets and a `tab.json`; no production tab identity/source is selected or
allowlisted here. Any necessary arbitrary compilation must happen separately in
an isolated unprivileged job, without signing/publication credentials. Build-job
artifacts are not publication authority and are never downloaded by author jobs.
The reviewed compiled blobs must be source-bound before trusted reconstruction.

All three kinds pack twice through the shared Rust CLI; exact archive bytes and
receipts must match. Providers support all explicitly declared target archives.
`pack-tab --package` additionally binds the compiled runtime manifest to the full
marketplace identity. Final schema-2 `package.json` and `submission.json` pass
Rust's shared `plan-publication` validation, including source repository/tag.
No Python/JavaScript registry-validator or archive implementation is introduced.

Public output contains every archive, `SHA256SUMS`, full `package.json`, full
`submission.json` and source-bound `release.json`. The latter is a preparation
receipt, **not** a substitute for registry-consumable package metadata. CLI logs,
local paths, environment and private scratch are excluded. Namespaced source-tag
URLs are canonical encoded GitHub Release URLs validated by shared Rust rules.

The source templates record known identity/license/runtime facts. The release
owner decided the official publisher (`cadencr`) and the first compatible desktop
(`min_app_version` `0.15.0`) on 2026-10-25; both are now in every template. Archive
URLs and digests remain `PENDING` placeholders (the preparer derives the real values
from the tag) and `publication` remains `PENDING`, so a production job still cannot
publish until that separate gate is approved. Do not invent compatibility versions
to make a job pass. Likewise, this change cannot promote a binary that lacks these
CLI rules.

There is no fixed platform matrix. A provider template declares in
`distribution.binary` only the OS/architecture targets it really supports, and the
marketplace filters by the user's platform. For Pi, `payloads` in `release-policy.json`
and the template's `distribution.binary` must name the same targets, and a target is
added only after its own native loopback qualification passed (see the
[Pi platform evidence](../docs/qa/MARKETPLACE_PI_PLATFORMS_2026_10_25.md)).

## Closed publication gate

The tag workflow remains preparation-only. A separate manual author workflow is
implemented but closed by `PENDING` policies and its own unpromoted author CLI pin.
No author credential, protected environment or registry signing key is provisioned
by this implementation. See the activation gates below.

Before enabling official publication, review:

- [ ] Source licenses for each active candidate.
- [ ] Supported native targets and canonical registry package metadata for each active candidate.
- [ ] Generic-host conformance and real supported-platform behavior.
- [x] Registry CLI publication/resume/recovery/renewal qualification with the distributed
      `0.13.1-dev.38974097824.1` binary in the isolated public QA registry.
- [x] Deliver the author-capable development CLI and verify its credential-free
      commands with the distributed ELF on isolated Linux.
- [x] Qualify original-author GitHub publication/retries/draft recovery with that
      binary and the dedicated QA user credential, including a separate fresh-runner
      replay. Inert QA theme only; registry mirror qualification remains distinct.
- [ ] Production CLI pin promotion and registry cutover.
- [ ] Protected signing authority and author-publication policy.

Environment approval alone cannot resolve these decisions. Future signing and
publication must use the shared released Rust CLI and revalidate the exact artifact
and source binding; do not introduce an alternate JavaScript publication path.

## Shared original-author engine

`cadencr-registry-publisher::author_release` now owns the original-author GitHub
inspection, content-bound draft publication and reconciliation state machine.
The desktop service delegates to this same library while retaining credentials,
project/database access, confirmation and operation journaling in the service.
Registry mirrors and signed catalog publication remain distinct operations.

The shared engine preserves the connected account, numeric repository identity,
exact source-tag commit, notes, binding digest and every expected archive/metadata
asset. It supports namespaced tags such as `plugins/theme-graphite/v0.1.0`, without
allowing slashes in asset names. Fixture tests cover interrupted writes, exact
read-only retries, changed sources and safe tag URL encoding.

The CLI now exposes two thin commands over that engine:

```sh
cadencr plugin inspect-release --request request.json --directory /canonical/artifacts
cadencr plugin publish-release --request request.json --directory /canonical/artifacts \
  --confirm-request-sha256 <reviewed-exact-request-digest>
```

- Inspection is fully local and needs no token. Its single JSON receipt contains
  the reviewed request and its exact-byte SHA-256, never local filesystem paths.
- Publication validates the request, content digests and confirmation before
  reading `CADENCR_AUTHOR_GITHUB_TOKEN`. Retry the same request after an unknown
  result; the shared engine reconciles the existing draft or published release.
- Portable schema `1` binds repository/account/numeric repository ID, tag/source
  commit, notes/prerelease and every asset's safe basename, byte size and digest.
  Unknown fields, unsafe paths, symlinks, duplicate names and oversized inputs fail.
- `metadata` is opaque to this low-level engine; the official preparer supplies
  Rust-validated full `package.json`, not its `release.json` receipt. This command grants no signing or registry authority.

The older registry-qualified CLI does **not** contain these new commands.
Author-capable `0.13.1-dev.39060688472.1` is now delivered from exact green main;
its public assets/provenance, isolated credential-free Linux QA and real GitHub
author publication/retry/draft recovery pass with inert theme fixtures in the
public QA repository. A separate fresh Linux runner reconciled the same release
without changing IDs, contents or mutation timestamps. This does not qualify Pi's
runtime or official package metadata. Both previously qualified binaries predate
marketplace tabs; all-three-kind delivery needs the new distributed-CLI gate. See the
[evidence and remaining gates](../docs/qa/MARKETPLACE_AUTHOR_CLI_2026_10_17.md).
Keep production policies and the dedicated author pin `PENDING` until the separate
production pin/policy/environment review is complete.

## Protected manual author workflow

`official-plugin-author.yml` runs only from trusted `main`. It reads candidate
provider/theme/tab Git objects as data and never executes candidate scripts or accepts artifacts
from another run. Both jobs independently reconstruct the same source-bound request.

| Dispatch input   | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `source_commit`  | Exact reviewed full commit containing approved plugin source/policy      |
| `tag`            | Existing allowlisted `plugins/<kind>-<id>/v<version>` tag at that commit |
| `request_sha256` | Sixty-four zeros inspect only; the emitted digest confirms a later run   |

Publication is conditional on the exact reconstructed digest and a separate
`official-plugin-publication` environment. The author secret is available only to
the final CLI step; catalog signing and registry submission are not included.
Unknown/unapproved plugin identities are refused. Pi and actual custom-tab shipping
remain gated on the source metadata, runtime/conformance and authority decisions.
Inspection exports public inputs for human review only; publication reconstructs
every byte independently and never consumes those uploaded artifacts.

Before activation, all of the following require explicit review:

- Deliver and qualify the actual author-capable binary; set
  `scripts/official-plugin-author-cli.env` to its exact version/tag/checksum.
- Review `scripts/official-plugin-author-policy.json`: numeric repository ID,
  expected author account, binary/pin digests and qualification evidence digest.
  Add `scripts/official-plugin-author-qualification.json` only after real binary
  qualification; its exact-byte digest and CLI version/checksum must match the
  policy. This reviewed summary is an attestation, not an automated certification.
- Approve both that policy and `plugins/release-policy.json`. `APPROVED` is an
  explicit future decision, not a state set by preparation or workflow dispatch.
- Provision the protected environment with reviewers, no self-approval or admin
  bypass, and `main`-only deployment rules; the workflow must not create it.
  Pin its numeric `environment_id` and explicitly review
  `admin_bypass_reviewed_disabled`. Runtime checks verify the existing environment,
  reviewers and branch rules. GitHub's documented response omits the admin-bypass
  setting, so its absence requires this reviewed attestation bound to that ID;
  an explicit API value enabling bypass is always rejected.
- Store a separately scoped user/bot credential matching the pinned account as
  `CADENCR_AUTHOR_GITHUB_TOKEN`. The engine authenticates via `GET /user`; the
  automatic Actions installation token is not a substitute. See
  [GitHub's supported user-token types](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).

No tags, official releases, registry entries, desktop trust roots or marketplace
visibility are changed by landing this code.

## Offline qualification preparation

`sh scripts/official-plugin-release.sh --qualification <repo> <commit> <tag> <new-absolute-output>`
uses the existing qualification pins and labels the output `authority: qualification`.
This explicit read-only mode grants no production signing or publication authority;
the tag workflow never enables it. It still requires an existing source-bound tag.

## Repository authority and private scratch

Both modes require the checkout origin to identify `merkr-software/CadencR`.
Production also requires matching `GITHUB_REPOSITORY`, `GITHUB_SHA` and
`GITHUB_REF` tag context; qualification requires no GitHub execution context and
never grants production authority. Public metadata records the canonical repository
identity, never the local checkout path.

Private scratch is retained and its path printed to stderr on packaging attempts.
Rust failures retain a private, bounded `cli-diagnostics.log` in that scratch
(maximum 64 KiB, mode `0600`). Public errors expose only the command stage and
stable error code; the log is never copied into output or uploaded.
There is no recursive cleanup: an unexpected database created in CLI HOME must
not be deleted. Review retained scratch separately; never upload it.
