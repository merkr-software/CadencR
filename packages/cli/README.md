# Cadencr CLI

`cadencr` provides headless plugin validation, theme/provider/tab packaging, registry index
signing and verified publication staging. Commands never contact the service or
database, install a plugin, or execute a provider binary; the one program they
run is a custom tab's own backend, for `plugin validate --kind tab` and
`--kind plugin` (below, `--no-run` to skip it).
`stage-publication` downloads inert GitHub Release assets. `mirror-publication`
can upload already verified local artifacts to an explicitly confirmed GitHub
draft; it never promotes that draft to a published release.
`promote-publication` separately requires the exact planned tag as confirmation
before publishing and independently checking public downloads.
`publish-catalog` independently publishes a verified signed catalog snapshot;
it does not create its Git tag or update the stable discovery pointer.
`advance-catalog` separately advances an explicitly confirmed, existing discovery
branch after verifying the published catalog and its local receipt.
`recover-publication` rebuilds missing local mirror proof for an already published
release; it never writes to GitHub and requires fully staged local archives.
`restore-publication` also fetches missing archives from that published managed
release into an existing empty or partial directory, never from author sources.

## Commands

```text
cadencr plugin validate <folder> --descriptor <descriptor.json>
cadencr plugin validate <folder> --kind theme
cadencr plugin validate <folder> --kind tab [--no-run]
cadencr plugin validate <folder> --kind lsp
cadencr plugin validate <folder> --kind plugin [--no-run]
cadencr registry validate --base <directory> --candidate <directory>
cadencr registry validate-metadata <file.json>...  # 1–32 local files; NOT authentication
cadencr registry validate-submission <submission.json>...  # 1–32 local files
cadencr registry check-metadata-expiry <envelope.json>... [--warning-hours <1..336>]
cadencr registry build-index --packages <directory> \
  --generated-at <timestamp> --expires-at <timestamp> \
  [--schema-version <1|2>] [--output <new-file>]
cadencr registry pack-provider --package <metadata.json> --target <target> \
  --directory <staging-directory> --output <new-archive.tar.gz>
cadencr registry pack-theme --directory <theme-staging-directory> \
  --output <new-theme.tar.gz>
cadencr registry pack-tab --directory <tab-staging-directory> \
  [--package <metadata.json>] --output <new-tab.tar.gz>
cadencr registry pack-lsp --directory <prepared-server-directory> \
  --target <darwin-aarch64|darwin-x86_64|linux-x86_64> --runtime <native|node> \
  --entry <relative-entry> --output <new-server.tar.gz>
cadencr registry pack-tab-backend --directory <tab-folder> \
  --target <darwin-aarch64|darwin-x86_64|linux-x86_64> --output <new-backend.tar.gz>
cadencr registry plan-publication --submission <submission.json> \
  --repository <owner/repository> --output <new-plan.json>
cadencr registry sign-index --payload <index.json> --private-key <private.pem> \
  --key-id <key-id> --output <new-envelope.json>
cadencr registry verify-index --index <envelope.json> --public-key <public.pem> \
  --key-id <key-id> [--allow-expired]
cadencr registry sign-theme-blocklist --payload <theme-policy.json> \
  --private-key <private.pem> --key-id <key-id> --output <new-envelope.json>
cadencr registry verify-theme-blocklist --index <theme-envelope.json> \
  --public-key <public.pem> --key-id <key-id> [--allow-expired]
cadencr registry sign-tab-blocklist --payload <tab-policy.json> \
  --private-key <private.pem> --key-id <key-id> --output <new-envelope.json>
cadencr registry verify-tab-blocklist --index <tab-envelope.json> \
  --public-key <public.pem> --key-id <key-id> [--allow-expired]
cadencr registry sign-lsp-blocklist --payload <lsp-policy.json> \
  --private-key <private.pem> --key-id <key-id> --output <new-envelope.json>
cadencr registry verify-lsp-blocklist --index <lsp-envelope.json> \
  --public-key <public.pem> --key-id <key-id> [--allow-expired]
cadencr registry sign-provider-blocklist --payload <provider-policy.json> \
  --private-key <private.pem> --key-id <key-id> --output <new-envelope.json>
cadencr registry verify-provider-blocklist --index <provider-envelope.json> \
  --public-key <public.pem> --key-id <key-id> [--allow-expired]
cadencr registry renew-policy --kind <provider|theme|tab|lsp> --current <envelope.json> \
  --public-key <public.pem> --key-id <key-id> --private-key <private.pem> \
  --expires-at <YYYY-MM-DDTHH:mm:ssZ> --output <new-envelope.json>
cadencr registry publish-policy --kind <provider|theme|tab|lsp> --signed <envelope.json> \
  --repository <owner/repository> --discovery-branch <branch> \
  --public-key <public.pem> --key-id <key-id> [--bootstrap | --renewal] [--receipt <new-receipt.json>]
cadencr registry fetch-policy --kind <provider|theme|tab|lsp> \
  --repository <owner/repository> --discovery-branch <branch> --output <new-envelope.json>
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
cadencr registry recover-publication --submission <submission.json> \
  --repository <owner/repository> --registry-commit <40-lowercase-hex> \
  --directory <staging-directory> --confirm-repository <owner/repository> \
  --confirm-recover <planned-release-tag>
cadencr registry restore-publication --submission <submission.json> \
  --repository <owner/repository> --registry-commit <40-lowercase-hex> \
  --directory <existing-directory> --confirm-repository <owner/repository> \
  --confirm-restore <planned-release-tag>
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
cadencr registry publish-registry --request <reviewed-request.json> \
  --directory <pipeline-state-directory> --repository <owner/repository> \
  --registry-commit <40-lowercase-hex> --private-key <private.pem> \
  --confirm-request-sha256 <sha256-of-exact-request-bytes>
```

Provider validation uses an explicit temporary host descriptor: the CLI does
not discover it from the user profile or database. `--kind theme` instead uses
the same declarative document validator as the service; no descriptor or provider
execution is involved. `--kind tab` validates a custom tab folder's `tab.json`
with the same rules the service applies before listing it (see
`docs/CUSTOM_TABS.md` §3): the folder name must equal the manifest `id`, scopes
must be known, origins canonical. It prints the permissions hash consent is
recorded against; warnings (such as an `http://localhost` origin) and an entry
or backend binary that is not built yet are reported without failing. When the
tab declares a native backend, every other platform's binary that is missing or
not native is noted. This platform's binary, when it is there but the host
would refuse to start it (a script, another format or CPU, unsigned arm64, not
executable), fails the command with `TAB_BACKEND_BINARY_REFUSED`, `--no-run` or
not; otherwise it is run, from the tab folder and with the manifest's
`backend.protocol`, through the protocol conformance checks of
`cadencr-tab-backend` (`docs/TAB_BACKEND_PROTOCOL.md`), and a failed check fails
the command with `TAB_BACKEND_CONFORMANCE_FAILED`. `--no-run` skips that run,
for machines that cannot execute the binary. `--kind plugin` validates a
multi-export plugin folder: its `plugin.json` (schema 1, closed, at most 64 KiB:
`id`, `name`, `version`, optional `description`, and 1–6 `contributes` members
of kind `provider`, `theme` or `tab`, each naming a distinct, non-nested
relative `path`, a provider also its `descriptor` file), then every member
folder with the validator of its kind as above (a tab member's backend runs
unless `--no-run`), then that every tab manifest `version` and provider
descriptor `agent.version` equals the plugin `version` and that member ids
differ from each other and from the plugin id once reduced to lowercase ASCII
letters and digits. Every problem is listed at once, one line per member, under
`PLUGIN_VALIDATION_FAILED`; `--descriptor` is refused. See
`tooling/marketplace-registry/AUTHORING.md` (Multi-export plugins). Local
validation does not establish publisher trust, publication completeness, or an
installed managed version.

### Declarative theme boundary

| Command                                                           | Input and guarantees                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin validate <folder> --kind theme`                           | Validates `theme.json` and its declared texture image; unrelated authoring files are not distribution content                                                                                         |
| `registry pack-theme --directory <staging> --output <new.tar.gz>` | Staging must contain exactly the validated document and declared raster image, with no executable bits, symlinks, scripts or extra files; deterministic shared archive writer and no-overwrite output |

Distributed documents use a closed property/token vocabulary, with a 256 KiB
JSON limit. Raster assets are PNG/JPEG/WebP only, at most 512 KiB each, 4096
pixels per side and 16 million pixels; animations, SVG and external URLs are
rejected. Header/structure validation bounds resources; complete image decoding
and PNG CRC verification remain the renderer's responsibility. Existing local
editor parsing and local asset formats remain backward-compatible.

Themes use the same publication, reconciliation and signed-catalog commands as
providers, with an explicit `kind: "theme"` schema-2 package. Their archive is
platform-independent data, never an ACP executable target. Desktop installation,
preview, activation, update, confirmed removal and duplication into an editable
author project reuse the shared validation libraries; the CLI does not change
installed desktop state.

### Custom tab boundary

A marketplace tab ships one platform-neutral **web archive** and, when its
`tab.json` declares a native `backend`, one **backend archive per platform**.
The two never mix: the web archive holds only `tab.json`, the icon and the
compiled web root (a backend executable found there is refused with a pointer
to `pack-tab-backend`), and a backend archive holds only its executable.

| Command                                                                                        | Input and guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry pack-tab --directory <staging> [--package <metadata.json>] --output <new.tar.gz>`    | Staging holds exactly `tab.json`, the icon and the compiled web root; no executable bits survive. With `--package`, the schema-2 metadata is bound to `tab.json`: identity, and for a backend tab equal `backend.protocol`/`reasoning`, the same platform set and each `distribution.binary.<p>.cmd` equal to `backend.binary.<p>`                                                                                                                                                                                    |
| `registry pack-tab-backend --directory <tab folder> --target <platform> --output <new.tar.gz>` | Packs the executable `tab.json` names for `<platform>`: a regular file inside the folder (not reached through a symlink), executable, native for the platform (ELF x86_64 for Linux; Mach-O, thin or universal, for macOS — arm64 code must carry a code signature), at most 128 MiB, outside `tab.json`, the icon and the web root. Deterministic ustar+gzip with exactly one entry at the manifest path, mode 0755, owner 0:0, mtime 0, no directory entries; at most 64 MiB; never overwrites. Nothing is executed |

`pack-tab-backend` prints the values of `tab.distribution.binary.<target>`
(the archive URL is yours to add, it is where you upload the file):

```json
{
  "kind": "tab-backend",
  "target": "darwin-aarch64",
  "archive": "/abs/backend.tar.gz",
  "sha256": "<archive sha256>",
  "size": 237328,
  "cmd": "bin/darwin-aarch64/port-monitor",
  "executable_sha256": "<executable sha256>",
  "executable_size": 602880
}
```

Run it once per platform, on that platform's CI runner if you like (it mirrors
`pack-provider --target`). The schema-2 entry then carries
`tab.backend: {protocol, reasoning}` (equal to `tab.json`) and
`tab.distribution.binary.<platform>: {archive, sha256, size, cmd,
executable_sha256, executable_size}`; both or neither. Every backend archive
must be a `.tar.gz` asset of the same GitHub release (same repository and tag)
as the web archive. `plan-publication` adds one `backend-<platform>` target per
platform, mirrored as `backend-<platform>-<sha256>.tar.gz` under the
`tab-<id>-v<version>` registry release, and `stage-publication` verifies each
backend archive (digests, single 0755 entry, native format) without executing
it. Failures use `TAB_BACKEND_PACKAGING_FAILED`.

`sign-tab-blocklist`/`verify-tab-blocklist` handle the custom-tab revocation
feed: a separate `kind: "tab-blocklist"` policy signed with the catalog key,
whose sorted, unique entries are `{tab_id, version_requirement?,
archive_sha256?, executable_sha256?, reason}` within a validity window of at
most 14 days.

`sign-provider-blocklist`/`verify-provider-blocklist` handle the managed-provider
revocation policy, the closed document `{schema_version: 1, generated_at,
expires_at, entries}` (no `kind`; entries `{provider_id, version_requirement?,
archive_sha256?, reason}`, sorted and unique, optional fields omitted rather
than `null`). Each policy domain is bound: a theme or tab policy never signs or
verifies as a provider policy, nor the reverse.

`renew-policy` renews one signed policy of the three kinds: it authenticates
`--current` with the pinned `--public-key` (an expired policy is accepted if it
is correctly signed), keeps `entries` identical, sets `generated_at` to now
(strictly newer than the current one) and `expires_at` to `--expires-at` (later
than the current expiry, at most 14 days after the new `generated_at`), refuses
a signing key other than the pinned one, verifies the signed result again and
only then writes the new file. Failures use `REGISTRY_POLICY_RENEWAL_FAILED`.

`publish-policy` writes a signed policy to its one fixed path on the discovery
branch (provider `managed-blocklist.json`, theme `managed-theme-blocklist.json`,
tab `managed-tab-blocklist.json`) with the token from
`CADENCR_REGISTRY_GITHUB_TOKEN` (never an argument). The candidate must be
current and authenticate; local checks run before the token is read. The policy
already on the branch must authenticate and be strictly older (no rollback);
when the file does not exist `--bootstrap` is required, and it is refused when
the file exists. The update is a single conditional write, followed by a public
read-back with the catalog's bounded convergence rules (up to six minutes, since
the raw CDN may serve the previous body for its 300-second cache lifetime; any
other body fails at once); `--receipt` writes a
small JSON record. `--renewal` (exclusive with `--bootstrap`) additionally
requires the published policy to carry exactly the candidate's entries, so a
renewal made from a stale baseline can never drop a newer revocation. Failures
use `REGISTRY_POLICY_PUBLICATION_FAILED`.

`fetch-policy` writes the policy as the authenticated GitHub API serves it from
the discovery branch head (token in `CADENCR_REGISTRY_GITHUB_TOKEN`), bypassing
the CDN cache, as the baseline for `renew-policy`. The bytes are unverified
until `renew-policy` or `verify-*-blocklist` authenticates them. Failures use
`REGISTRY_POLICY_FETCH_FAILED`.

`build-index --schema-version 2` validates and wraps legacy provider source
metadata in memory while retaining immutable files and ACP extensions. This is
unsigned assembly, not conversion of signed proof. Schema 1 still rejects mixed
packages. Protected publication separately requires authenticated baseline
continuity and explicit schema-upgrade confirmation.

`build-index` writes canonical index bytes to stdout unless `--output` is
provided. Output bytes are first completed in a temporary file beside the
destination, then published with create-new semantics. Existing files and
symlinks are never overwritten, and a failed write leaves no partial index at
the requested path.

`pack-provider` emits a JSON receipt containing the absolute archive path,
target, SHA-256 and compressed size. The shared app/CLI engine rejects symlinks,
special files, sensitive paths, portable-name collisions and changing input.
Archives are deterministic for the same implementation; decompressed TAR bytes
match frozen historical JavaScript fixture observations, but gzip bytes need not match across
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

`recover-publication` requires a published, non-prerelease release at the exact
reviewed tag and registry commit. Repository, tag, commit and submission checks
precede credentials. The same protected token environment is used for authenticated
read access, never for a GitHub mutation. Local archives must already be fully
staged: missing bytes fail without any author/source download.

Recovery verifies local receipt bindings, authenticated asset bytes, exact tag,
independent public bytes, stable asset identities and final remote state before
writing a missing `mirror-receipt.json` with status `published_recovered`. Existing
valid mirror receipts are preserved, including historical `draft_verified` status,
but only after verifying the remote release is now published. A matching existing
publication receipt is allowed even without a mirror receipt. Recovery never
creates `publication-receipt.json`; use promotion verification afterward. Replays
recheck remote evidence and never overwrite conflicting receipts. Acquisition of
managed archives on an empty runner is available separately through
`restore-publication`.

`restore-publication` requires the same confirmations (using `--confirm-restore`),
token and immutable release binding. The destination directory must already exist
and must not be a symlink. Existing receipts are checked before remote acquisition;
archive-size equality is checked after staging. The release must already be
published and its exact tag, commit, body and managed assets must match before
missing archives are fetched. No author URL fallback or GitHub mutation occurs.

Retained and downloaded target archives share a `1 GiB` staging budget, with
`256 MiB` per archive. This is not a total network-traffic budget: subsequent
independent public-byte verification downloads artifacts again. Restoration
preserves the original plan and valid receipts, reuses full recovery verification,
and creates only missing staging/mirror proof, never a publication receipt.
The initial release identity remains bound through final verification.

`sign-publication-catalog` reads a manifest containing `schema_version: 1` or `2`,
`repository`, and `publications` entries with `submission`, `directory`, and
`registry_commit`. Relative paths resolve from the manifest parent. Every entry
must have matching staging, mirror and publication receipts. All local inputs,
package identities/ownership, dates and resource budgets validate before public
downloads; the signing key is read only afterward. No GitHub token is needed.
The output must be absent under a non-symlink directory; signing never overwrites
an existing catalog. The manifest limit is 1 MiB and 100 **delta entries**; aggregate submission input
and catalog payload limits are 32 MiB. A `baseline` supplies `previous_index`,
`public_key` and `key_id`; its verified immutable history is merged with the
delta, not re-downloaded. An empty delta renews validity with no historical asset
requests. Public verification is bounded per publication, not by total registry
history. The result is signed locally, not published remotely.

`publish-catalog` verifies the candidate and optional previous signed catalog with
one explicit public key. The previous digest binds its exact input bytes;
existing package versions cannot disappear or change, and the catalog timestamp
must advance. Input catalogs and the canonical output are limited to 32 MiB.
The authenticated baseline plus verified publication delta must produce exactly
the signed payload. Schema-1 to schema-2 transitions require
`--allow-schema-upgrade`; downgrade is forbidden.

The publication directory must already exist and must not be a symlink. Exact
repository and computed catalog-tag confirmation precede credential access:
`catalog-<sha256>` for schema 1, `marketplace-v2-<sha256>` for schema 2.
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
`bootstrap` means only that its `managed-index.json` is absent. An explicit
authenticated schema upgrade may initialize the new schema-2 file on an existing
branch. No branch is created automatically. Branch names are 1–64 ASCII letters/digits/underscores/
hyphens and must start with a letter or digit.

The current discovery file must match the baseline, or exactly equal the candidate
for replay. Before a single compare-and-swap Contents API write, the command
rechecks the head, manifest, published catalog, tag and freshness. A lost write
response is reconciled, never blindly retried. The raw public URL is downloaded
without authentication or redirects; exact bytes and a stable final head are
required before `discovery-receipt.json` is written. Catalog files are bounded to 32 MiB.
Keep the exact published baseline file: its raw-byte digest must match the
current discovery bytes, including insignificant JSON whitespace.

Schema 2 requires the isolated `marketplace-v2` discovery branch and
`marketplace-v2-<sha256>` catalog tag. Schema 1 cannot publish to that branch.
The legacy provider-only feed is independent, not an automatically projected or
re-signed subset of mixed bytes. Older clients receive later provider updates
only while maintainers explicitly continue publishing the legacy feed.
Current desktop clients can read schema 1 or 2; provider-only display views never
replace the original signed mixed payload in cache, receipts or install requests.

## Diagnostics and exit codes

Pass `--json` for one structured diagnostic object. For `build-index` without
`--output`, stdout remains the index JSON itself; failures are still structured
JSON on stderr. `check-metadata-expiry` likewise always writes its report to
stdout (even when unhealthy and with `--json`); failures use stderr. Help and
version retain clap's human-readable output.

| Code | Meaning                                      |
| ---: | -------------------------------------------- |
|  `0` | Success, help, or version                    |
|  `1` | Plugin or registry input failed validation   |
|  `2` | Invalid CLI usage                            |
|  `3` | Generated output could not be written safely |

## Migration status

The shared Rust CLI/libraries are the sole registry business implementation;
replaced JavaScript validators, packers and publishers have been removed. Thin
CI orchestration and independent test/cryptography helpers remain JavaScript.
Source readiness does not deploy the real registry or activate desktop UI.

The candidate template pins qualified `0.13.1-dev.39108033875.1` for existing CI
commands. The three standalone commands below were added **after that release**:
merge this source, publish/qualify a new CLI, then review its exact pin and
regenerated registry delivery payload. Do not run the full migrated template
against the old binary or infer release qualification from a local build.

### Standalone metadata diagnostics

| Command                                     | Contract                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry validate-metadata <files>...`     | 1–32 local package/unsigned-index/signed-index files; all three package kinds; strict semantic shape validation, **not** signature authentication |
| `registry validate-submission <files>...`   | 1–32 source-pinned submissions; shared ownership/URL/kind rules; no network, archive download or executable invocation                            |
| `registry check-metadata-expiry <files>...` | 1–3 local signed envelopes, including domain policies; read-only timestamp scheduling, **not** contract/signature verification                    |

Metadata/catalog reads are bounded to 32 MiB per file; submissions to 1 MiB.
Symlinks and special files are refused. Expiry uses the current UTC clock and
whole-second canonical timestamps. `--warning-hours` accepts 1–336 (default 72).
The report contains `diagnostic_only: true`, a `results` array and
`authenticated: false` per result. At or below the warning interval the status
is `renewal-due`; at/beyond expiry it is `expired`. Healthy reports exit `0`;
unhealthy/malformed/unsafe inputs exit `1`, with `METADATA_RENEWAL_DUE` or
`METADATA_EXPIRY_CHECK_FAILED` on stderr. A healthy timestamp is never authority
to acquire, install, execute or publish anything.

Numeric canonicalization matches JavaScript and is covered by a deterministic
263-case Node oracle. The app accepts the shared canonical signature format and
retains explicit legacy verification, including the exact verified-byte hashes
in existing receipts. Catalog publication and stable discovery are explicit;
protected pipeline orchestration and verified fresh-runner state recovery are
implemented locally. Released-artifact parity and deployment remain gates.

## Initial release runtime

The first downloadable Linux binary targets the registry's Ubuntu 24.04 x86-64
CI runners, matching its build and execution-smoke environment. Its GNU target
name is not a promise of compatibility with older Linux distributions. General
CLI platform distribution remains outside this initial registry-only release.

## Protected registry pipeline

`publish-registry` is an explicit protected-operator command. Its request contains
`schema_version: 1` or `2`, `repository`, `key_id`, `discovery_branch`, `generated_at`,
`expires_at`, `previous_index` (`bootstrap` or a relative file), `public_key`
(relative PEM file), and `publications` containing relative `submission` paths
and optional exact `registry_commit` values (omit the field instead of using
`null`). Confirm the SHA-256 of the exact
reviewed request bytes. The private key must remain outside the state directory.
Local request, continuity, key-pair and existing-state checks precede reading
`CADENCR_REGISTRY_GITHUB_TOKEN` or creating state/network writes.

Unlike standalone publication commands, this pipeline explicitly creates missing
package/catalog tags at the confirmed commits. Existing tags must match exactly;
ambiguous writes are reconciled by reads, never blindly retried. `publications`
is a bounded delta, not the complete catalog history; an authenticated baseline
retains history. Entries run sequentially with a per-publication staging budget;
verified transient archives are removed while receipts and operation state remain.
Explicit delta replays restore only verified managed destination bytes, never
retired author URLs. An empty delta renews the catalog without package downloads
or package-release mutations. An explicit schema upgrade also requires
`allow_schema_upgrade: true` and the separate `marketplace-v2` discovery branch. Catalog
signing follows verified publication/public-byte evidence; discovery follows
verified catalog publication. State and matching receipts support replay without
overwriting conflicts. Use protected credentials and a trusted, stable directory;
no contributor executable is run by this pipeline.

## Preparing Linux release artifacts

The manual `cli-preparation.yml` workflow builds artifacts without publishing a
release or creating a tag. Provide a full reviewed source SHA, its coordinated
branch and an explicit stable `vX.Y.Z` matching `packages/cli/Cargo.toml`. The SHA
must be the fetched branch tip; topology and version checks precede candidate
checkout and execution. Supporting Rust tests and the CLI build use `--locked`.

The seven-day workflow artifact contains the executable
`cadencr-vX.Y.Z-x86_64-unknown-linux-gnu`, `cadencr-vX.Y.Z-SHA256SUMS`, and
`preparation.json` recording source, version and target. Verify the checksum
before use. These are preparation artifacts, not an activated registry CLI pin.

This preparation workflow has read-only repository permissions and no signing
secrets. Stable CLI releases come from the workflow below, not from application
tags.

## Stable CLI releases

The CLI has its own semver, independent of the desktop app: an app release
neither bumps it nor ships it (app releases up to `v0.14.0` carried a Linux CLI
asset, which stays on those releases). To release a CLI version, bump `version`
in `packages/cli/Cargo.toml` and `packages/cli/package.json` (and the
`cadencr-cli` entry of `Cargo.lock`) in a normal PR; `scripts/cli-version.test.mjs`
keeps the three equal. Once it is on `main` with green CI, launch **Release CLI**
(`.github/workflows/cli-release.yml`) on `main` with that full main-tip SHA:

```bash
gh workflow run cli-release.yml --ref main \
  -f source_commit=<full-reviewed-current-main-sha> -f dry_run=false
```

It uses the development release's gate (dispatch SHA = fetched `main` tip with
successful main CI), refuses a version whose `cli/vX.Y.Z` tag or release exists,
and runs tests, build and packaging read-only and secret-free. `dry_run`
(default) stops there. Otherwise the `cli-release` environment's reviewers
approve publication of exactly that artifact: tag `cli/vX.Y.Z` at the source
commit, then a GitHub release with `cadencr-vX.Y.Z-x86_64-unknown-linux-gnu`, its
`SHA256SUMS`, `provenance.json` and a `released-cli.env` pin:

```dotenv
CADENCR_RELEASE_VERSION=0.14.0
CADENCR_RELEASE_TAG=cli/v0.14.0
CADENCR_RELEASE_SHA256=<reviewed-64-character-lowercase-sha256>
```

The release is a normal release, never marked **Latest**: the desktop
auto-updater and the landing download page follow the repository's latest
release, which stays the app's. It is not flagged as a prerelease either, since
it is a stable artifact and `--prerelease` marks the development channel below.
A consumed version is never reused: if publication fails after the tag exists,
bump the version and release again.

## Manual development CLI releases

After `.github/workflows/cli-dev-release.yml` is merged and pushed to `main`,
launch **Release development CLI** from GitHub Actions on `main` and supply its
full reviewed current commit SHA:

```bash
gh workflow run cli-dev-release.yml --ref main \
  -f source_commit=<full-reviewed-current-main-sha>
```

The source commit must match the dispatch and fetched `main` tip, and its main
CI must be green. Tests/build run without write authority; a separate publication
job publishes only the reviewed artifact. No desktop build, app version bump,
Apple credentials, updater metadata or registry signing key is involved.

For package base `0.13.1`, a run produces a unique version such as
`0.13.1-dev.123456789.1`, tag `cli/v0.13.1-dev.123456789.1`, and binary reporting
`cadencr 0.13.1-dev.123456789.1`. The narrowly validated compile-time
`CADENCR_CLI_RELEASE_VERSION` override does not edit package manifests or the
lockfile; ordinary builds continue to report their package version. Existing
tags/releases/assets are never overwritten. These are prereleases, never the
repository's latest release.

If publication fails after creating its tag or draft, retain that state and
rerun the **whole workflow** to obtain a new attempt/version. Do not delete or
reuse the consumed identity. Rerunning only the publication job is intentionally
not a resume mechanism: its original build artifact belongs to an earlier
attempt. This workflow does not qualify registry interruption/recovery behavior.

The release includes the raw Linux executable, its versioned `SHA256SUMS`,
`provenance.json` and a candidate `released-cli.env`:

```dotenv
CADENCR_RELEASE_VERSION=0.13.1-dev.123456789.1
CADENCR_RELEASE_TAG=cli/v0.13.1-dev.123456789.1
CADENCR_RELEASE_SHA256=<reviewed-64-character-lowercase-sha256>
```

The trusted downloader accepts this exact tag/version binding, the stable
`cli/vX.Y.Z` binding above, and legacy two-field pins, which resolve to the
application release `vX.Y.Z` that carried CLIs up to `0.14.0`. Independently verify the published source
binding, checksum and downloaded binary before selecting a candidate for QA.
No workflow run changes the checked-in qualification or production pins; the
production pair remains `PENDING` until real lifecycle qualification is complete.
Marketplace UI remains hidden in production.

## Language-server authoring

See the [native and prepared Node examples](../../tooling/marketplace-registry/examples/lsp/README.md)
for the signed language associations, launch arguments, target receipts, and
standalone or plugin member submissions. `pack-lsp` executes no code or package
installation; a Node bundle must already contain all dependencies. Local LSP
validation reads `lsp.json` and checks each entry's signed size, SHA-256 and native
platform, without starting it. The registry staging boundary verifies complete
archives before publication.

These commands describe the source CLI in this checkout. The registry template's
qualified released CLI pin remains a separate release and adoption decision.
