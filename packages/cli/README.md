# Cadencr CLI

`cadencr` provides headless provider validation, packaging, registry index
signing and verified publication staging. Commands never contact the service or
database, install a plugin, or execute a provider binary.
`stage-publication` downloads inert GitHub Release assets. `mirror-publication`
can upload already verified local artifacts to an explicitly confirmed GitHub
draft; it never promotes that draft to a published release.
`promote-publication` separately requires the exact planned tag as confirmation
before publishing and independently checking public downloads.
`publish-catalog` independently publishes a verified signed catalog snapshot;
it does not create its Git tag or update the stable discovery pointer.
`advance-catalog` separately advances an explicitly confirmed, existing discovery
branch after verifying the published catalog and its local receipt.

## Commands

```text
cadencr plugin validate <folder> --descriptor <descriptor.json>
cadencr registry validate --base <directory> --candidate <directory>
cadencr registry build-index --packages <directory> \
  --generated-at <timestamp> --expires-at <timestamp> [--output <new-file>]
cadencr registry pack-provider --package <metadata.json> --target <target> \
  --directory <staging-directory> --output <new-archive.tar.gz>
cadencr registry plan-publication --submission <submission.json> \
  --repository <owner/repository> --output <new-plan.json>
cadencr registry sign-index --payload <index.json> --private-key <private.pem> \
  --key-id <key-id> --output <new-envelope.json>
cadencr registry verify-index --index <envelope.json> --public-key <public.pem> \
  --key-id <key-id> [--allow-expired]
cadencr registry assemble-signed-index --payload <index.json> \
  --signature <signature.json> --output <new-envelope.json>
cadencr registry stage-publication --submission <submission.json> \
  --repository <owner/repository> --directory <staging-directory>
cadencr registry mirror-publication --submission <submission.json> \
  --repository <owner/repository> --registry-commit <40-lowercase-hex> \
  --directory <staging-directory> --confirm-repository <owner/repository>
cadencr registry promote-publication --submission <submission.json> \
  --repository <owner/repository> --registry-commit <40-lowercase-hex> \
  --directory <staging-directory> --confirm-repository <owner/repository> \
  --confirm-publish <planned-release-tag>
cadencr registry sign-publication-catalog --manifest <publications.json> \
  --generated-at <timestamp> --expires-at <timestamp> \
  --private-key <private.pem> --key-id <key-id> --output <new-catalog.json>
cadencr registry publish-catalog --catalog <signed-catalog.json> \
  --previous-index <previous-catalog.json|bootstrap> --public-key <public.pem> \
  --key-id <key-id> --manifest <publications.json> --repository <owner/repository> \
  --registry-commit <40-lowercase-hex> --directory <publication-directory> \
  --confirm-repository <owner/repository> --confirm-publish <catalog-sha256-tag>
cadencr registry advance-catalog --catalog <signed-catalog.json> \
  --previous-index <previous-catalog.json|bootstrap> --public-key <public.pem> \
  --key-id <key-id> --manifest <publications.json> --repository <owner/repository> \
  --registry-commit <40-lowercase-hex> --directory <publication-directory> \
  --confirm-repository <owner/repository> --confirm-publish <catalog-sha256-tag> \
  --discovery-branch <existing-branch> --confirm-discovery <exact-raw-GitHub-URL>
```

Plugin validation currently covers local **provider** structure only. The
descriptor is an explicit temporary host input: the CLI does not discover it
from the user profile or database. A successful result does not establish
publication completeness or validate theme assets.

`build-index` writes canonical index bytes to stdout unless `--output` is
provided. Output bytes are first completed in a temporary file beside the
destination, then published with create-new semantics. Existing files and
symlinks are never overwritten, and a failed write leaves no partial index at
the requested path.

`pack-provider` emits a JSON receipt containing the absolute archive path,
target, SHA-256 and compressed size. The shared app/CLI engine rejects symlinks,
special files, sensitive paths, portable-name collisions and changing input.
Archives are deterministic for the same implementation; decompressed TAR bytes
match the transitional JavaScript oracle, but gzip bytes need not match across
compression implementations. The output directory must be trusted and stable.

`plan-publication` records expected release tags, asset names and provenance.
It does not fetch artifacts, mirror them, sign a catalog or publish to GitHub.

`sign-index` uses an Ed25519 PKCS8 PEM private key; `verify-index` requires an
explicit key ID and Ed25519 SPKI PEM public key. Signing and verification enforce
whole-second UTC dates and omitted empty optional fields. `--allow-expired` is
an explicit verification-only override. Assembly validates structure but does
not authenticate a detached signature. `verify-index` verifies only the strict
current publication format, not every structurally valid assembly. Legacy app
signature compatibility is a separate service-only path; assembly is not a way
to bypass current publication policy. Verify current-format envelopes before use.
Private keys are local inputs, never registry content or CLI arguments containing
key material. Generated envelopes are private, no-clobber files.

`stage-publication` downloads at most six archives over allowlisted HTTPS GitHub
redirects, checks size and SHA-256, and writes an immutable receipt. Repeating a
matching staging request revalidates existing bytes and fetches only missing
assets. Conflicting assets/receipts and foreign locks fail closed. Staging does
not upload, promote a release, or publish a catalog. Use a trusted local staging
directory, not one concurrently writable by an untrusted process. Files are
synced, but directory entries are not a power-loss durability guarantee. A crash
or failure to inspect a newly created file can leave a lock/partial: it is kept
rather than deleted without proven ownership. Inspect such leftovers manually
before retrying; the CLI never removes a foreign lock automatically.

`mirror-publication` requires `CADENCR_REGISTRY_GITHUB_TOKEN` after local
submission, commit and destination-confirmation validation. Supply it through a
protected environment, not a command argument or checked-in configuration. All
artifacts must already be staged: mirroring never fetches author sources. It
binds the exact registry commit, release body, artifact bytes and provenance;
retries reconcile existing state rather than overwrite conflicts. The resulting
`mirror-receipt.json` records a verified draft, not public availability. Existing
Git tags must resolve to the specified commit (annotated tags are peeled with a
five-hop bound). A draft may not have created its tag yet; publication will require
that additional check.

`promote-publication` requires a verified local mirror receipt and complete staged
artifacts, the same protected token environment, and an existing tag resolving
to the exact registry commit. It never creates or uploads missing artifacts.
Before publishing, authenticated downloads must match the bound bytes. After
publishing, independent unauthenticated downloads must match too; only then may
`publication-receipt.json` be written. A lost publish response is reconciled by
reading the exact release, never by blindly retrying a mutation. Existing
publication proof forbids silently republishing a release that reverted to draft.
Prereleases are refused. Already-published replay verifies public bytes without
redownloading the same assets through the authenticated API.
This operation does not sign or publish a catalog or update discovery.

`sign-publication-catalog` reads a manifest containing `schema_version: 1`,
`repository`, and `publications` entries with `submission`, `directory`, and
`registry_commit`. Relative paths resolve from the manifest parent. Every entry
must have matching staging, mirror and publication receipts. All local inputs,
package identities/ownership, dates and resource budgets validate before public
downloads; the signing key is read only afterward. No GitHub token is needed.
The output must be absent under a non-symlink directory; signing never overwrites
an existing catalog. The manifest limit is 1 MiB and 100 entries; aggregate
submission input and catalog payload limits are 32 MiB, and public downloads are
bounded to 1 GiB in total. The result is signed locally, not published remotely.

`publish-catalog` verifies the candidate and optional previous signed catalog with
one explicit public key. The previous digest binds its exact input bytes;
existing package versions cannot disappear or change, and the catalog timestamp
must advance. Both input catalogs and the canonical output are limited to 1 MiB.
The manifest must produce exactly the signed payload from verified publications.

The publication directory must already exist and must not be a symlink. Exact
repository and computed `catalog-<sha256>` confirmation precede credential access.
The protected `CADENCR_REGISTRY_GITHUB_TOKEN` environment variable authorizes the
GitHub release operation; no token is accepted as a command-line argument.
The computed Git tag must already resolve to `--registry-commit`. Publication
never creates or moves it. Draft creation, upload and promotion reconcile lost
responses without blindly repeating writes. Only independently verified public
bytes may produce `catalog-publication-receipt.json`; replay refuses conflicts.
The existing trusted-directory ancestry limitation applies here too.

`advance-catalog` requires `catalog-publication-receipt.json` from the matching
published snapshot. Repository, catalog tag, and raw URL confirmation plus local
receipt validation precede token access. The discovery branch must already exist;
`bootstrap` means only that its `managed-index.json` is absent. No branch is
created automatically. Branch names are 1–64 ASCII letters/digits/underscores/
hyphens and must start with a letter or digit.

The current discovery file must match the baseline, or exactly equal the candidate
for replay. Before a single compare-and-swap Contents API write, the command
rechecks the head, manifest, published catalog, tag and freshness. A lost write
response is reconciled, never blindly retried. The raw public URL is downloaded
without authentication or redirects; exact bytes and a stable final head are
required before `discovery-receipt.json` is written. Files are bounded to 1 MiB.
Keep the exact published baseline file: its raw-byte digest must match the
current discovery bytes, including insignificant JSON whitespace.

## Diagnostics and exit codes

Pass `--json` for one structured diagnostic object. For `build-index` without
`--output`, stdout remains the index JSON itself; failures are still structured
JSON on stderr. Help and version retain clap's human-readable output.

| Code | Meaning                                      |
| ---: | -------------------------------------------- |
|  `0` | Success, help, or version                    |
|  `1` | Plugin or registry input failed validation   |
|  `2` | Invalid CLI usage                            |
|  `3` | Generated output could not be written safely |

## Migration status

The local validation CLI and Linux release/registry-CI wiring are implemented.
The registry still uses its JavaScript gate until a real release version and
SHA-256 digest are provisioned in the trusted pin file. No release is implied by
building this crate locally.

Numeric canonicalization matches JavaScript and is covered by a deterministic
263-case Node oracle. The app accepts the shared canonical signature format and
retains explicit legacy verification, including the exact verified-byte hashes
in existing receipts. Catalog publication and stable discovery are explicit;
pipeline/recovery orchestration remain subsequent migrations.

## Initial release runtime

The first downloadable Linux binary targets the registry's Ubuntu 24.04 x86-64
CI runners, matching its build and execution-smoke environment. Its GNU target
name is not a promise of compatibility with older Linux distributions. General
CLI platform distribution remains outside this initial registry-only release.
