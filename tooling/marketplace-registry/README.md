# Cadencr Marketplace Registry Template

## Status and runtime

The registry stores reviewed metadata and GitHub Release assets. All marketplace
business rules run in **the Rust `cadencr` CLI**, built in the Cadencr monorepo
from the same libraries used by the desktop service. There is no JavaScript
validator, packer, signer, publisher or fallback in this template.

The remaining Node code is test infrastructure and small CI security/process
orchestration; it does not implement package or publication rules. Frozen legacy
fixtures record historical compatibility, not a second executable implementation.
See [test authority and coverage](tests/COVERAGE.md).

This is source preparation, **not evidence of deployment**. Reinspect the actual
registry default branch and protections before delivering it. Desktop visibility
and production trust/feed configuration are unchanged by this migration.

| Runtime contract                                                                             | Local selection / delivery status                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contribution validation, schema-2 index building and protected publication                   | `ci/released-cli.env` locally selects qualified `0.15.4`                                                                                          |
| `validate-metadata`, `validate-submission`, `check-metadata-expiry` and full template checks | Included in the exact qualified release; see [provider-author and offline qualification](../../docs/qa/MARKETPLACE_STABLE_CLI_0154_2026_11_02.md) |
| Bootstrap, CI cutover and production adoption                                                | Review preparation only; fresh payload approvals, bootstrap merge and hosted checks remain pending                                                |

The [qualification record](../../docs/qa/MARKETPLACE_STABLE_CLI_0154_2026_11_02.md)
binds this selection to released artifacts and qualification. It does not adopt a
production pin or grant author/catalog publication authority.

No placeholder digest or source-built executable may masquerade as a qualified
release. Missing, invalid or unsupported runtime inputs fail; do not restore a JS
fallback. Author publication pins and production authority remain separate gates.

## Repository layout

| Path                  | Purpose                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `packages/*.json`     | One immutable package entry per kind/identity/version                        |
| `submissions/*.json`  | Matching author-source repository, commit, tag and changelog                 |
| `schemas/`            | Structural reference schemas; the Rust semantic validators are authoritative |
| `ci/released-cli.env` | Reviewed executable version/tag/SHA-256 pin, parsed as data                  |
| `scripts/ci/*.sh`     | Trusted executable acquisition, process guards and CI wiring                 |
| `.github/`            | Candidate PR checks, review form and protected workflow templates            |
| `tests/`              | Actual-CLI smoke tests, orchestration checks and frozen compatibility data   |

Legacy provider schemas remain reference contracts, not schemas for mixed theme/tab
entries. Use the [Rust CLI contract](../../packages/cli/README.md) for all kinds.

## Language-server source support

The source CLI supports standalone `lsp` entries and LSP members of a plugin.
See [prepared native and Node authoring examples](examples/lsp/README.md) and
the reference [package schema](schemas/marketplace-lsp-package-v1.schema.json).
These additions require releasing and qualifying a CLI with LSP support before
the protected template can accept them; the existing qualified pin above is
unchanged. Real package assets and the independent signed LSP policy must be
published before enabling LSP installation in a production build.

## Contributor path

1. Validate and test your provider, declarative theme or custom tab locally.
2. Package inert staging with `registry pack-provider`, `pack-theme` or `pack-tab`.
3. Publish immutable assets and exact source bindings in the author's repository.
4. Add matching package and submission JSON files in a registry PR.
5. Run trusted Rust validation against the accepted base and proposed tree; maintainers
   review ownership, source/build provenance, licenses and permissions independently.

```sh
cadencr registry validate --base /reviewed/base --candidate /reviewed/candidate

# Use the locally selected qualified CLI 0.15.4.
cadencr registry validate-metadata /reviewed/package.json
cadencr registry validate-submission /reviewed/submission.json
```

Standalone metadata validation does **not** authenticate signatures. Use the
appropriate explicit public-key/trust verification command before trusting signed
metadata. Passing a local preflight is not acceptance or publication authority.

Existing versions cannot be edited or removed through an ordinary contribution.
A new version needs a new immutable entry and source-pinned submission. Publisher
and source ownership continuity are enforced across versions; whitespace/key order
alone are not semantic mutations. See [contribution policy](CONTRIBUTING.md).

## Unsigned index preparation

```sh
cadencr registry build-index --schema-version 2 \
  --packages /reviewed/candidate/packages \
  --generated-at YYYY-MM-DDTHH:mm:ssZ --expires-at YYYY-MM-DDTHH:mm:ssZ \
  --output /trusted/new-unsigned-index.json
```

Use actual whole-second UTC times within the contract's validity bounds. Existing
outputs are never overwritten. Empty registry snapshots are valid contribution
bootstrap inputs, but empty publishable catalogs are deliberately refused.
Unsigned preparation does not establish availability, ownership or trust.

## Protected publication and recovery

The operator-only `registry publish-registry` pipeline stages exact inert archives,
mirrors them into **registry-owned GitHub Releases**, signs the catalog and advances
its verified discovery feed. The author's repository remains provenance; it is not
the mirrored distribution origin. No contributor module, binary or archive script
is executed by registry checks or publication.

Requests contain a bounded publication **delta**, not the full historical catalog.
The authenticated previous catalog supplies immutable history. An empty delta with
an authenticated baseline renews catalog validity without re-downloading historical
packages. Schema 2 uses the separate `marketplace-v2` branch; a schema upgrade is
explicit and cannot silently redirect older consumers.

```sh
cadencr registry publish-registry --request /reviewed/publication-request.json \
  --directory /trusted/operation-state --repository OWNER/REGISTRY \
  --registry-commit REVIEWED_40_HEX_COMMIT \
  --private-key /protected/outside-state/private.pem \
  --confirm-request-sha256 REVIEWED_REQUEST_FILE_SHA256
```

This example grants no authority. Review the exact immutable commit, request and
referenced inputs. Keep key material outside source/state; supply the dedicated
`CADENCR_REGISTRY_GITHUB_TOKEN` only through a protected environment. Use canonical,
trusted, stable state paths. No production key or credential is included here.

Preserve operation state after failure. Retry the **same** bound request; reconcile
remote evidence instead of changing dates, overwriting releases or deleting state.
An error can occur after tags, releases or discovery have already advanced.
Fresh-runner recovery reconstructs missing proof from authenticated remote assets,
never raw uploaded recovery state or untrusted PR artifacts. Standalone
`restore-publication` / `recover-publication` are GET-only and never fall back to
retired author URLs. See [operations](OPERATIONS.md) and the
[full CLI contracts](../../packages/cli/README.md#protected-registry-pipeline).

## Pull-request CI and released executable trust

Both required checks, `inert-metadata` and `contributor-tooling`, obtain helpers and
the pin from the **trusted base commit**, not the PR's proposed tooling. Candidate
metadata remains inert. Jobs use ordinary `pull_request`, read-only permissions,
no secrets and no contributor archive downloads. The tooling check builds a
schema-2 unsigned index using Rust; it never runs candidate npm scripts.

The fetcher constructs the fixed official release URL, restricts redirects,
checks SHA-256 **before execution**, then verifies the exact version. Protected
publisher selection separately verifies the required command before loading its
signing key. Errors stop the job; no alternative business runtime exists.

Execution scratch is retained and its path printed on success or failure. Do not
upload it or recursively delete it: unexpected database/state files must remain
untouched. Disposable hosted runners provide isolation; these wrappers do not
constitute a sandbox against hostile local processes.

### Remote deployment requires two reviewed changes

Recheck the actual public registry state before each delivery; prior temporary
bootstrap/cutover hashes are invalid after template bytes change.

1. If helpers/pins are absent from the trusted base, deliver them in a bootstrap
   change **without switching the existing validation workflow**. Use a newly
   released/qualified CLI supporting the full migrated template.
2. From the merged base, deliver Rust workflow selection and source cleanup;
   observe actual hosted contribution checks for all three kinds. Preserve the
   required-check names and the explicitly agreed repository protection policy.

Protected publisher/renewal/revocation deployment, environments, credentials,
root custody and monitoring require separate reviewed operator authorization.
No source change here activates the desktop marketplace or publishes seed plugins.

## Tests

```sh
# In the Cadencr source checkout; builds the actual CLI through pnpm rust.
pnpm --dir tooling/marketplace-registry test

# In a copied standalone registry, explicitly supply the verified NEW executable.
CADENCR_REGISTRY_TEST_CLI=/absolute/path/to/cadencr npm test
```

Node 22 is test/orchestration infrastructure only; no registry npm dependency or
business command is installed. A missing, non-executable or unsupported CLI fails
tests rather than skipping coverage. The exhaustive implementation/security
matrix runs in the monorepo Rust suites; the portable suite does not duplicate it.
