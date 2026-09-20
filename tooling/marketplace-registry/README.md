# Cadencr Marketplace Registry Template

This directory is a portable bootstrap for the GitHub-only registry described in
`docs/MARKETPLACE_V1.md`. It is a template, not a deployed registry, and contains
no production URL, trust key, credential, or remote resource.

## Repository layout

| Path                                | Purpose                                                        | Trust domain                           |
| ----------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `packages/*.json`                   | One reviewed `ManagedProviderPackage` per provider version     | Contributor PR input                   |
| `submissions/*.json`                | Source-pinned submission matching each new package version     | Contributor PR input                   |
| `schemas/`                          | JSON Schema documents for package and signed-index shape       | Public validation                      |
| `scripts/validate.mjs`              | Dependency-free semantic validation matching managed index v1  | Unprivileged CI                        |
| `scripts/build-index.mjs`           | Deterministic sort and canonical unsigned index creation       | Unprivileged CI or protected publisher |
| `scripts/assemble-signed-index.mjs` | Joins a detached signature to the exact canonical payload      | Protected publisher only               |
| `.github/`                          | PR form and example workflows to copy to a registry repository | Repository bootstrap                   |

## Local checks

Requires Node `>=22.19.0 <23.0.0`.

```bash
cd tooling/marketplace-registry
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run validate
npm run validate:submission -- /path/to/submission.json
npm run validate:contribution -- --base /path/to/base-registry --candidate /path/to/candidate-registry
npm run build:index -- \
  --generated-at 2026-09-12T00:00:00Z \
  --expires-at 2026-09-19T00:00:00Z \
  --output /tmp/managed-index.json
npm run assemble:index -- \
  /tmp/managed-index.json \
  /secure/path/signature.json \
  /tmp/signed-managed-index.json
```

`build:index` requires an explicit publication time and expiry (at most 14 days
later) and writes only the unsigned `ManagedProviderIndex`. Signing is a
separate protected operation. The signing system must sign the exact bytes in
that output (without a trailing newline); it must never download or execute provider archives.
`assemble:index` only validates and joins the unsigned payload with a detached
signature document; it does not sign or publish anything.

The tests and fixtures travel with this directory when copied into a standalone
registry repository. Cadencr root tests additionally check that these fixtures
remain byte-identical to the service contract. Executable validation derives
allowed object fields from the schemas and adds host-specific semantic checks;
this is not a general-purpose JSON Schema engine.

## Local publication primitives

```bash
npm run plan:publication -- \
  --submission /path/to/reviewed-submission.json \
  --repository YOUR-ORG/YOUR-REGISTRY \
  --output /tmp/publication-plan.json
npm run sign:index -- \
  --payload /path/to/verified-mirrored-index.json \
  --private-key /secure/path/ed25519-private.pem \
  --key-id YOUR-PINNED-KEY-ID \
  --output /tmp/signed-managed-index.json
```

- `plan:publication` produces deterministic source/destination mappings and a
  mirrored package document without downloading, executing, or publishing anything.
  It preserves the reviewed source submission. The destination repository is an
  explicit parameter, not a configured production registry. Supported containers
  are `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, and `.zip`; raw executables are
  deliberately excluded from this publication planner.
- A plan is **not evidence of availability or provenance**. Its mirrored package
  must not enter a published index until every remote destination has been verified
  against the approved SHA-256. Never alter accepted source metadata in place.
- `sign:index` validates and canonicalizes the existing index v1 payload, signs
  with an Ed25519 private key, and verifies the signature before exclusive output.
  Signing requires canonical whole-second UTC timestamps (`YYYY-MM-DDTHH:mm:ssZ`)
  and omitted empty optional authors/arguments/environment fields, matching Rust
  serialization; ambiguous spellings are rejected rather than signed incorrectly.
  It neither contacts archive URLs nor proves that they exist. Inputs are bounded
  (submission 1 MiB, index 32 MiB, key 16 KiB) and must remain stable during reads;
  non-regular files and symlinks are refused, not sandboxed. Keep key files out
  of the repository; use ephemeral test keys for local trials, never production keys.
- These commands are deliberately not connected to the example publication workflow yet.
  Draft mirroring is a separate explicit command below. Source-build provenance
  verification and serialized protected publication/discovery are still required.

## Pull-request CI and released CLI cutover

The `inert-metadata` check always checks out validation code from the reviewed
base SHA and applies it to a separate candidate checkout. It has read-only
permissions, receives no secrets, and never runs candidate scripts or provider
archives.

The workflow is prepared to run the released Rust CLI from the official
`merkr-software/CadencR` GitHub release path. `ci/released-cli.env`
deliberately uses `PENDING` pins until that binary actually exists. Provisioning
requires a reviewed exact version and lowercase SHA-256 for the raw
`cadencr-v<VERSION>-x86_64-unknown-linux-gnu` asset. The trusted helper constructs
the release URL itself, restricts redirects, verifies SHA-256 before execution,
and checks `cadencr --version` before invoking any registry command.

Do not accept a contributor-controlled version, digest, or download URL. While
both pins are `PENDING`, the helper executes the existing trusted JavaScript gate.
Replacing both pins atomically cuts the same job over to the Rust CLI without
executing candidate code in that trusted gate. Preserve the `inert-metadata`
job/check name so branch-protection requirements do not silently disappear.

The existing `contributor-tooling` check name is preserved too. In `PENDING`
mode it runs the legacy candidate tests; once pinned, the trusted helper instead
uses the released CLI to build the throwaway candidate index and never runs
candidate scripts. No additional code change is required for that cutover.

## Verified local archive staging

```bash
npm run stage:publication -- \
  --submission /path/to/reviewed-submission.json \
  --repository YOUR-ORG/YOUR-REGISTRY \
  --directory /trusted/workspace/staged-provider-version
```

This command downloads the reviewed public source archives into a local staging
folder. It revalidates the submission and derives the plan itself; a hand-edited
plan cannot authorize a different download. It does **not** upload to the proposed
registry repository, extract archives, run providers, sign, or publish an index.

- Each archive is streamed, limited to 256 MiB and checked against the submitted
  SHA-256 before it receives its final filename. Targets are processed sequentially.
- HTTPS only, public GitHub release URLs, explicit redirect allowlist, at most
  three redirects and a two-minute deadline per download. No authentication or
  cookies are sent; private release assets are unsupported.
- Existing valid files are rehashed and reused. Conflicting bytes or a receipt
  for a different plan cause failure without overwriting them. A later failure
  preserves already verified archives so a retry can reuse them.
- `staging-receipt.json` is written only after all archives verify. It records the
  source submission, intended destinations and locally observed digests/sizes,
  **not remote publication or source-build provenance**.
- Use a dedicated trusted staging directory per provider/version. Concurrent
  attempts fail on an exclusive lock. A crashed process can leave its lock or
  temporary file behind; there is no automatic stale-lock deletion. Inspect the
  directory and confirm the owning process has stopped before manual recovery.
- The directory and its ancestors must remain trusted/stable. These filesystem
  checks do not provide a sandbox against another process replacing paths.

## Explicit GitHub draft mirroring

> This command performs remote writes when run against GitHub. Do not run it as a
> local check or from a PR job. Configure a reviewed destination and scoped token
> through a protected operator environment first.

```bash
# CADENCR_REGISTRY_GITHUB_TOKEN must come from the protected environment.
# Use an exact reviewed registry commit, not a moving branch name.
npm run mirror:publication -- \
  --submission /path/to/reviewed-submission.json \
  --repository YOUR-ORG/YOUR-REGISTRY \
  --registry-commit EXACT_40_CHARACTER_LOWERCASE_COMMIT_SHA \
  --directory /trusted/workspace/staged-provider-version \
  --confirm-repository YOUR-ORG/YOUR-REGISTRY
```

- Stage every source archive first. Mirroring revalidates local bytes and does not
  fetch missing source archives. `GITHUB_TOKEN` is not read implicitly.
- A new release remains a **draft**, bound to the canonical plan digest and exact
  registry commit. Published releases and conflicting metadata are refused.
- Missing archives and `publication-plan.json` are uploaded without replacement.
  Each remote asset is downloaded through the authenticated GitHub asset endpoint,
  then digest-checked. Credentials are sent only to the fixed API/upload hosts,
  never forwarded to CDN redirects.
- Release and asset discovery are bounded to ten pages of 100 entries each;
  exceeding that limit fails rather than silently treating an item as absent.
- An uncertain create/upload response triggers reconciliation with remote state,
  not a blind second write. Retry verifies matching existing bytes; incomplete
  `starter` assets, unexpected assets or digest conflicts fail closed. Nothing is
  deleted automatically; an operator must investigate ambiguous state.
- `mirror-receipt.json` records a fully verified draft, **not public availability**.
  An old receipt is historical evidence only: retries always recheck remote bytes.
- Keep the local directory stable and serialize operator runs. A local lock is not
  cross-runner GitHub workflow concurrency control. Repository protections and
  deployed publication controls, signing and discovery remain pending.

## Explicit release promotion and public verification

> `promote:publication` publishes an existing draft on GitHub. This is a remote
> mutation, not a dry run. Use only after operator approval in a protected
> environment; never run it from contributor/PR code.

```bash
npm run promote:publication -- \
  --submission /path/to/reviewed-submission.json \
  --repository YOUR-ORG/YOUR-REGISTRY \
  --registry-commit EXACT_40_CHARACTER_LOWERCASE_COMMIT_SHA \
  --directory /trusted/workspace/staged-provider-version \
  --confirm-repository YOUR-ORG/YOUR-REGISTRY \
  --confirm-publish EXACT_PLANNED_RELEASE_TAG
```

- Requires the existing staging and mirror receipts, the dedicated environment
  token, matching release identity and freshly verified remote bytes.
- The release tag must already exist and resolve to the reviewed registry commit.
  Lightweight and bounded annotated tags are supported. This command never creates
  or moves a tag. Check the tag before invocation through your approved operator flow.
- Publishes only that release, without marking it latest. No uploads, asset
  replacement, deletion, signing or catalog edits occur.
- Checks the tag binding again after publication and downloads every public archive
  and provenance URL **without credentials**. Only then writes the immutable
  `publication-receipt.json`; the mirror receipt stays unchanged.
- If publication succeeds but public verification fails, the release remains
  published. The command fails and emits no new success receipt; it never hides
  the failure by rolling back. Retry validates existing state without republishing.
- Both receipts are historical evidence, not permanent availability guarantees.
  Protected environments, immutable releases, tag protections and distributed
  concurrency must still be configured. Local locks cannot enforce those policies.

## Sign a verified publication catalogue

`sign:publication-catalog` prepares a **local signed index**, not a GitHub release
or discovery update. It consumes an operator-authored manifest of already promoted
provider versions. Paths are resolved relative to the manifest file.

```json
{
  "schema_version": 1,
  "repository": "YOUR-ORG/YOUR-REGISTRY",
  "publications": [
    {
      "submission": "reviewed/provider-1.0.0.json",
      "directory": "staged/provider-1.0.0",
      "registry_commit": "0123456789abcdef0123456789abcdef01234567"
    }
  ]
}
```

```bash
npm run sign:publication-catalog -- \
  --manifest /trusted/workspace/catalogue-publications.json \
  --generated-at YYYY-MM-DDTHH:mm:ssZ \
  --expires-at YYYY-MM-DDTHH:mm:ssZ \
  --private-key /protected/ed25519-private.pem \
  --key-id YOUR-PINNED-KEY-ID \
  --output /trusted/workspace/signed-index.json
```

- Requires both mirror and publication receipts for every entry; checks their
  identity against the reviewed submission, staged bytes and canonical plan.
- Uses mirrored package URLs, deterministic ordering and the existing signed-index
  wire format. All included versions must have matching publication evidence.
- Re-downloads public archives and provenance without a GitHub token before reading
  the signing key. Missing, changed or unavailable bytes fail closed.
- Limits: 1 MiB manifest, 100 versions, 1 MiB per submission, 32 MiB of
  submission input and payload, 1 GiB of aggregate public assets. Receipt files
  retain their individual 4 MiB limit. Transfers remain sequential and bounded
  per asset. No archives are extracted and no provider code is executed.
- Uses an Ed25519 PKCS8 key, canonical whole-second UTC dates and the existing
  maximum 14-day publication window. Output is private and no-overwrite.
- Run only trusted tooling with protected, stable manifest/staging paths. Local
  receipts are not cryptographic authorization or proof of source ownership.
- This is not catalog-history reconciliation: operators must include the approved
  complete version set. Continuity against the previously published catalogue,
  monotonic publication time, serialized snapshot upload, public verification of
  the signed snapshot and discovery advancement remain publication-time gates.

## Publish a versioned catalogue snapshot

> `publish:catalog` creates/uploads/publishes a GitHub release. Run only with
> explicit operator approval and a repository-scoped token from the protected
> environment. It never advances discovery or marks a release `latest`.

```bash
npm run publish:catalog -- \
  --catalog /trusted/workspace/signed-index.json \
  --previous-index /trusted/workspace/previous-signed-index.json \
  --public-key /protected/ed25519-public.pem \
  --key-id YOUR-PINNED-KEY-ID \
  --manifest /trusted/workspace/catalogue-publications.json \
  --repository YOUR-ORG/YOUR-REGISTRY \
  --registry-commit EXACT_40_CHARACTER_LOWERCASE_COMMIT_SHA \
  --directory /trusted/workspace/catalogue-snapshot \
  --confirm-repository YOUR-ORG/YOUR-REGISTRY \
  --confirm-publish catalog-FULL_CANONICAL_ENVELOPE_SHA256
```

- Create the empty working directory beforehand. For the initial snapshot only,
  explicitly pass `--previous-index bootstrap`. This is an operator assertion, not
  proof that no prior catalogue exists remotely.
- The public key is a trusted Ed25519 SPKI PEM file, **not a contributor input**.
  Both catalogues must verify against that key and exact key ID. Rotation requires
  a separate policy; this command never infers a new trusted key.
- An expired previous catalogue is accepted for history validation; the candidate
  must still be fresh. Every previous version must remain byte-equivalent in
  canonical package metadata, and `generated_at` must strictly increase.
- Envelope input and published bytes are limited to **1 MiB**, matching the app's
  acquisition limit. The lower-level local signer has a larger preparation limit;
  its output is not automatically publishable.
- The release tag is `catalog-` plus SHA-256 of the canonical signed envelope with
  its final newline (the D5 CLI emits those bytes). The tag must already point to
  the exact registry commit; this command does not create or move Git references.
- Before any release write, the manifest must produce the exact signed payload and
  all included public provider archives/provenance must verify again.
- The release contains only `managed-index.json`. Matching existing assets are
  verified, not overwritten. Lost responses are reconciled before further writes.
  Already published snapshots can be reverified without republishing.
- `catalog-publication-receipt.json` is written only after the public snapshot is
  downloaded without credentials and matches the expected bytes. A verification
  failure after publication leaves the release published, with no new success
  receipt; retry verifies rather than unpublishing or deleting.
- Baseline selection is operator-owned. This command proves continuity relative
  to the supplied signed baseline, **not that it is the current discovery head**.
  Protected deployment, distributed serialization, atomic discovery advancement,
  blocklist publication and live GitHub QA remain separate gates. The current app
  expects a signed envelope at its configured URL, not a discovery-pointer schema.

## Advance stable catalogue discovery

> `advance:catalog` commits the signed envelope to a dedicated existing GitHub
> branch. It changes what users discover and therefore requires explicit operator
> approval. No branch, release, provider artifact or private key is created here.

```bash
npm run advance:catalog -- \
  --catalog /trusted/workspace/signed-index.json \
  --previous-index /trusted/workspace/previous-signed-index.json \
  --public-key /protected/ed25519-public.pem \
  --key-id YOUR-PINNED-KEY-ID \
  --manifest /trusted/workspace/catalogue-publications.json \
  --repository YOUR-ORG/YOUR-REGISTRY \
  --registry-commit EXACT_40_CHARACTER_LOWERCASE_COMMIT_SHA \
  --directory /trusted/workspace/catalogue-snapshot \
  --confirm-repository YOUR-ORG/YOUR-REGISTRY \
  --confirm-publish catalog-FULL_CANONICAL_ENVELOPE_SHA256 \
  --discovery-branch catalog \
  --confirm-discovery https://raw.githubusercontent.com/YOUR-ORG/YOUR-REGISTRY/refs/heads/catalog/managed-index.json
```

- The existing branch is an explicit deployment choice; its name is restricted to
  a single alphanumeric/underscore/hyphen segment. The fixed file is
  `managed-index.json`, containing the signed envelope directly, not a pointer.
  No official repository or app production URL is provisioned by this template.
- Requires an exact existing D6 publication receipt, the published snapshot and
  tag binding, valid signature/history, and fresh public artifact verification.
- Reads the authoritative current file using the GitHub Contents API. It must
  match the supplied signed previous catalogue, or already contain the candidate
  for retry. `bootstrap` permits creation only when the file is absent on an
  existing branch; it never replaces an existing different catalogue.
- The update carries the observed Git blob SHA. A concurrent different update
  fails; the tool never retries using a newer SHA or overwrites the winner.
  A lost response is accepted only after re-reading the exact candidate bytes.
- After mutation/replay, the raw stable URL is downloaded without credentials and
  checked before `discovery-receipt.json` records success. Stale caches or public
  failures can leave discovery advanced without a success receipt; retry verifies
  the same candidate without another write. There is no automatic rollback.
- Restrict branch writers and configure repository protections. Blob compare-and-
  swap protects competing updates to this file, not unauthorized later rollback
  or deletion by another writer. Use one publication concurrency group across all
  publisher workflows; a local lock is not a distributed lock.

The existing preparation workflow now runs only from the default branch, checks
out its exact triggering commit and shares a non-cancelling publication concurrency
group. It remains **unsigned and read-only**. Wiring the privileged hosted-runner
pipeline, approved input/artifact handoff, keys, environment reviewers and branch
protections is a separate deployment gate; the template does not claim those
controls have been provisioned or live-tested.

## Deliberate limits

The contribution command compares two registry snapshots without executing their
scripts. New versions require matching package/submission documents. Accepted
versions cannot be removed or changed, and new versions cannot silently change
the publisher or source repository. Unchanged legacy packages may remain without
a submission; the command does not retroactively infer provenance for them.
The snapshots are inputs, not publication targets: no GitHub calls, writes or
downloads occur. See `SECURITY.md` for CI bootstrap and trust boundaries.
Snapshot inputs must be stable during validation. Each JSON file is limited to
1 MiB, each metadata directory to 10,000 entries, and each registry root to
32 MiB of JSON input across `packages/` and `submissions/`. Symlinks and special
files are refused. These resource limits are not an OS-level filesystem sandbox.

The source-pinned submission preflight is a separate author/reviewer command.
It does not change the managed package/index v1 wire format and does not prove
source ownership or reproducible-build provenance. See `CONTRIBUTING.md` for
the submission envelope and remaining human verification requirements.

- This template does not select the production repository, release URLs,
  supported-platform policy, signing service, or trusted key.
- Draft mirroring requires explicit repository confirmation and a dedicated token.
  It does not publish releases, sign automatically, or update public discovery.
- JSON Schema catches shape errors; `validate.mjs` is also required for semantic
  rules such as semantic ordering, HTTPS archives, reserved arguments, and the
  credential-field ban.
- Schema validation and conformance do not establish publisher trust or code
  safety. Maintainer review and protected publication remain mandatory.

## Protected publication pipeline

`publish:registry` composes the existing staging, provider mirroring/promotion,
verified signing, snapshot publication and stable discovery commands. It is an
**operator command with remote-write authority**, not a contributor command.
It creates only missing publication tags at exact commits; existing tags must
already resolve to the approved commit and are never moved or deleted.

A reviewed request describes the complete catalogue, not just the new package:

```json
{
  "schema_version": 1,
  "repository": "OWNER/REGISTRY",
  "key_id": "registry-2026",
  "discovery_branch": "catalog",
  "generated_at": "2026-09-19T12:00:00Z",
  "expires_at": "2026-09-26T12:00:00Z",
  "previous_index": "bootstrap",
  "public_key": "trust/public.pem",
  "publications": [{ "submission": "submissions/provider-0.1.0.json" }]
}
```

Replace example values and publication dates before review. Paths are relative to
this request's directory, bounded and non-symlink; traversal outside that directory
is refused. For updates, `previous_index` names the exact previous signed catalogue
instead of `bootstrap`. Each publication may specify `registry_commit` to retain
its original release binding; otherwise the command's reviewed commit is used.
Never rebind an existing provider version to a later registry commit.

```sh
npm run publish:registry -- \
  --request publication-request.json \
  --directory /trusted/operator-state/request-001 \
  --repository OWNER/REGISTRY \
  --registry-commit REVIEWED_40_HEX_COMMIT \
  --private-key /protected/outside-state/private.pem \
  --confirm-request-sha256 REVIEWED_REQUEST_FILE_SHA256
```

The dedicated `CADENCR_REGISTRY_GITHUB_TOKEN` must be supplied separately. Review
both the immutable checkout commit and the request digest; the digest alone does
not bind referenced files in an untrusted mutable checkout. Keep all input and
state ancestors trusted and quiescent. Never place private keys inside publication
state or source submissions. The pipeline does not execute or extract archives.

State paths must be canonical and non-symlink, including their ancestors (resolve
system aliases such as macOS `/tmp` before choosing a state path). The private-key
path is rejected if its canonical target is inside that state directory. Source
staging shares a 1 GiB budget across retained files and new downloads; each transfer
receives the remaining limit. Public-asset verification is repeated at security
boundaries, so the total network traffic of a complete run can exceed 1 GiB.

The state directory is immutably bound to one request and reviewed commit. Preserve
it after failures. Retrying that exact request revalidates existing receipts and
public bytes without changing existing releases, assets, tags or catalogue bytes.
A failure can leave tags, drafts or published assets behind, and a failed final raw
verification can leave discovery advanced without its receipt. It is not a global
transaction and does not authorize rollback or cleanup of remote assets. Local
input preflight is not a guarantee that every future remote operation will succeed:
a conflicting tag on a later provider can leave earlier providers published. No
catalogue is signed or advertised unless all provider gates complete. The catalogue
tag is checked after verified signing, not by signing an unverified payload early.

### Hosted workflow and recovery boundary

Install `.github/workflows/publish-protected-catalog.yml` in the actual registry
repository only after configuring the `protected-marketplace-publisher` environment
with required reviewers, the two dedicated secrets
`CADENCR_REGISTRY_GITHUB_TOKEN` and `CADENCR_REGISTRY_PRIVATE_KEY_PEM`, and appropriate
branch/tag/release protections. The default branch must contain a reviewed
`publication-request.json` and its public inputs. The dispatch takes its explicit
SHA-256 confirmation, checks out the exact dispatch commit, and uses the shared
non-cancelling publication lane. It does not run contributor code or package
installation scripts. No official repository, protection or secret is provisioned
by this template.

The workflow preserves non-secret publication state as a run/attempt-specific
artifact. The signing key is stored separately and cleaned up. A fresh runner can
now reconstruct published provider receipts from the exact reviewed release:

1. Stage missing bytes from the official mirrored URLs and verify their approved
   SHA-256 digests, without contacting the original author release.
2. Verify release identity, immutable binding, actual tag commit, complete assets
   and public archive/provenance bytes, then relist assets, reverify authenticated
   bytes and recheck remote identity/tag.
3. Record a `published_recovered` mirror receipt. This proves verified recovery,
   not an observed historical draft. Existing conflicting receipts are never replaced.
4. Reuse the normal promotion/signing/snapshot/discovery gates. Same-request replay
   reconstructs the same signed bytes and performs no duplicate publication writes.

No Actions artifact is restored or executed. Rerun the workflow at its original
reviewed commit and with the same request digest/window; expiration still fails
closed. Only genuinely new entries may use the missing/draft mirroring path and require
original source archives unless local staging survives. Versions identified in the
verified signed baseline must still have an exact published release; disappearance
or reversion to draft is a fatal error, not permission to download from the author
or recreate the release. An observed published state is retained for the invocation,
and recovered/published local receipts also prevent re-promotion as a draft. Recovery never repairs
an incomplete known-published release by uploading/replacing assets. Explicit
`bootstrap` with no retained receipt, signed baseline or observed release is a new
publication request; absence alone cannot prove deleted publication history.

For a subsequent catalogue request, use a new state directory, retain all prior
versions and their original `registry_commit` values, include the exact signed
baseline file, and choose a strictly newer valid publication window. Old published
providers can be rehydrated from their official mirrors; only new providers need
author archive availability. Repository protections, reviewer approval and actual
GitHub/Actions deployment remain external gates, not something local fixture tests
prove. Inspect retained artifacts only as operator diagnostics; do not treat their
contents as publication authority. Verify artifact access/retention against your
operating policy before deployment.
