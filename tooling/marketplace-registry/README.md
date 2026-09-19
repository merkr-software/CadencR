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
- These commands are deliberately not connected to the example workflow yet.
  Draft mirroring is a separate explicit command below. Source-build provenance
  verification and serialized protected publication/discovery are still required.

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
