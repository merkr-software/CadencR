# Distributed original-author CLI qualification

## Boundary

- QA orchestration only: production packaging/publication rules remain in the
  released Rust CLI and shared Rust libraries. No source-built fallback.
- Fixed public target: `merkr-software/cadencr-registry-qa`, numeric repository
  ID `1420296872`. No registry submission, signing or official plugin publication.
- The theme is inert declarative data derived from Graphite. See `PROVENANCE`
  and the preserved Apache-2.0 `LICENSE`.

## Reviewed inputs

Deploy `workflow.yml` as `.github/workflows/author.yml` in the QA repository,
alongside the harness, fixtures and reviewed released-CLI fetcher. Keep the
existing registry QA workflow, signing secret and registry CLI pin unchanged.

| File                        | Required binding                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `author-cli-candidate.json` | Exact CLI version/checksum, fixed public repository/ID, user account, unique `qa-author-cli/<suffix>` tag and full source commit |
| `author-cli-pin.env`        | The same released version/checksum and `cli/v<version>` tag; parsed as data, never sourced                                       |
| Candidate source commit     | Existing QA tag points here; tracked theme bytes match the harness fixture                                                       |
| Dispatch                    | Reviewed workflow commit equals `github.sha`; exact candidate-file SHA-256                                                       |

Create the source commit and unique QA tag first, then commit the candidate and
pin referencing it. Never move an existing tag or overwrite release assets.

## Runs and credentials

1. Dispatch with `publish=false`. A clean Linux runner fetches the exact public
   ELF, then runs local validation, canonical packaging, inspection and wrong
   confirmation rejection without network access or inherited credentials.
2. Only after that succeeds, dispatch with `publish=true` and, for a fresh tag,
   `interrupt_draft=true`. The final step alone receives a separately approved
   user-associated `QA_AUTHOR_GITHUB_TOKEN`. The automatic Actions token cannot
   authenticate the author's `/user` identity.
3. Verify exact immutable public asset bytes, then same-state and fresh-scratch
   retries. Changed assets/requests must fail with the expected CLI diagnostic
   and leave the independently verified remote inventory unchanged.

The optional TLS-blind proxy holds the upload connection, observes an empty
bound draft, terminates only its owned CLI child, then resumes the exact request
and requires the same release ID. This proves **draft interruption/recovery**,
not arbitrary lost-response recovery.

## Evidence and limits

- Upload only the explicit public proof JSON, never the scratch directory,
  subprocess output, environment, credentials or keys.
- Scratch is intentionally retained. Never recursively remove it: an unexpected
  Cadencr database must not be deleted.
- Unit tests use synthetic processes/network observations. They do not qualify a
  distributed executable; record real workflow and release evidence separately.
- QA success does not promote production pins/policies or enable marketplace UI.

## Local harness tests

```sh
node --test scripts/qualify-author-cli.test.mjs scripts/author-cli-qa-workflow.test.mjs
```

## Three-kind qualification candidates

Each dispatch reads one exact reviewed `author-cli-candidate.json`. `kind` is
required and is exactly `provider`, `theme`, or `tab`; theme-only candidates
without it are deliberately rejected. Use a distinct `qa-author-cli/<suffix>`
tag per kind, each bound to its committed fixture source SHA (sources may differ by kind).
Preserve old tags and releases. Deploy the complete `scripts/author-cli-qa/` tree and
`scripts/qualify-author-cli.py` before creating those source tags. Then commit
candidate and binary pin, and dispatch with that final reviewed commit and the
SHA-256 of the exact candidate bytes.

```json
{
  "kind": "provider",
  "cli_version": "0.13.1-dev.39108033875.1",
  "cli_sha256": "d11bfade6297fa30e1e10e82605f5a221da8e07edeeee372e2c2f6185c6ff725",
  "repository": "merkr-software/cadencr-registry-qa",
  "repository_id": 1420296872,
  "public": true,
  "expected_account": "REVIEWED-AUTHOR",
  "tag": "qa-author-cli/wave3-provider-unique",
  "source_commit": "REPLACE_WITH_40_CHARACTER_QA_FIXTURE_COMMIT"
}
```

- `fixtures/provider/bin/provider` is inert text, never executed. Packaging marks
  only its private scratch copy executable. Two archives exercise
  `additional_archives`: `linux-x86_64` and `darwin-aarch64`.
- `fixtures/tab/dist/index.html` is a deliberately tracked compiled-entry fixture;
  preserve its narrow `.gitignore` exceptions when deploying tracking tests.
  `fixtures/tab/` contains static HTML with no script, permissions, or network.
  It is inspected and packaged, never loaded into a renderer. Its package requires
  app version `999.0.0` to make the QA-only identity unmistakable; no released-app
  runtime support is claimed. Proof explicitly records `runtime: not_executed`.
- `theme.json` remains the original declarative theme fixture.
- Package metadata uses the full schema-2 `{kind, package}` envelope with
  `qa-author-provider`, `qa-author-theme`, and `qa-author-tab` identities. The
  released CLI validates it through `registry build-index --schema-version 2` and
  `registry plan-publication` before author publication. README/license assets are
  included in the provider inventory and archive; the submission/plan remain
  private scratch, not release assets. No Python business validator substitutes
  for Rust validation. Disposable index
  validation uses current UTC plus one day only in CLI arguments; timestamps do
  not enter the published metadata or content-bound author request.
- The portable **author release request** remains schema version `1`, as required
  by that independent Rust API. Metadata and archive URLs bind the namespaced
  source tag with `%2F` encoding and archive digests.
- Every archive and metadata asset is changed independently for a rejected
  publication probe; immutable public inventory must remain exactly unchanged.
- Mocked orchestration tests are not released-ELF qualification evidence. A Linux
  runner must execute offline and public jobs using the reviewed released binary.

## Development regression, not released-binary qualification

The Rust CI job builds the current source CLI and enables this additional fixture
contract test. It catches compiled-entry and publication-metadata errors before
hosted author QA; it does not replace the downloaded Linux executable checks.
It also packs a backend tab (`pack-tab` plus `pack-tab-backend` for every
platform, from synthesized inert native headers that are never executed) and
checks the `backend-<platform>` publication targets. Native-backend candidates are supported by the harness but are not qualified
until the separately reviewed distributed workflow is exercised.

```sh
CADENCR_DEVELOPMENT_FIXTURE_CLI="$PWD/target/debug/cadencr" \
  python3 -B scripts/author-cli-qa/test_harness.py
```

## Native-backend tab candidate

For a new tab-only candidate, optionally set `"tab_variant": "native-backend"`.
Omission or `"ui-only"` preserves existing tab behavior; this field is rejected
for providers/themes and all other values are rejected. Never change an existing
request, candidate tag, or release to switch variants: create a fresh source tag
and reviewed candidate instead.

The native variant binds both static UI fixtures and the tracked deterministic
`native_fixture.py` generator bytes to the source commit. That generator contains
all inert Mach-O/ELF header data (macOS arm64/x64 and Linux x64); no compiler,
download, credentials, or runnable backend is involved. Static validation always
uses `--no-run`. The Rust CLI packs each backend first, supplying its exact
archive/executable receipt fields to `pack-tab --package`; the UI archive remains
the primary author archive and every platform is an `additional_archives` entry.
Publication, retry, independent inventory and tamper probes reuse the same author
request path. This is harness coverage, **not distributed-CLI qualification**;
that still requires the separately reviewed deployed workflow and real evidence.
