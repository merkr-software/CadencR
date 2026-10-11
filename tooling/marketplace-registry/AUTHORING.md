# Prepare a provider release locally

These commands prepare artifacts only. They do not create a GitHub repository,
publish a release, submit a registry PR, or establish publisher trust.

## Implement and test the connector

Create a provider project in Cadencr, or import an existing built Git repository.
Implement the existing executable contract:

- `version`: exact implementation version;
- `models --format acp-config-options-v1 --cwd <absolute-path>`: model discovery;
- `run --protocol acp-v1`: ACP v1 over standard input/output.

Native CLI installation/authentication is the user's responsibility. Document
prerequisites in the connector README; never put credentials in the archive,
metadata, executable arguments, or environment declarations. Test the connector
locally in Cadencr and restart after registration/build changes. Packaging alone
does not run or replace model-discovery/ACP conformance tests.

## Build a dedicated staging directory

Build the executable for each platform you intend to support, outside the
registry tools. Copy only distributable files into a dedicated staging directory:

```text
staging/
  bin/provider
  assets/icon.svg
  README.md
  LICENSE
```

Paths must match `agent.distribution.binary[target].cmd` and `host.assets` in
your managed package metadata. Do not pass your source checkout or home directory
as staging. The tool rejects symlinks, special files and common secret-prone
filenames, but this denylist is not proof that files contain no secrets. Review
every staged file. Staging must be trusted and quiescent: do not modify it while
packaging. Identity and directory checks detect changes, but the Node-based packer
is not a filesystem sandbox against an actively hostile process on the same
machine. Protected publication must never package an untrusted live checkout.

## Package and record the checksum

Using the portable registry tooling with Node 22:

```bash
npm run pack:provider -- \
  --package /path/to/package.json \
  --target darwin-aarch64 \
  --directory /path/to/staging \
  --output /path/to/artifacts/provider-0.1.0-darwin-aarch64.tar.gz
```

The output parent directory must already exist. Existing output files and output
inside staging are refused. The tool does not execute the connector or build
scripts. It emits JSON containing `target`, `archive`, `sha256` and compressed
`size`. Identical staged bytes and executable modes yield identical archives
when using the same tooling/runtime; test reproducibility with your release runner.

The input package must validate structurally, including its SHA-256 field. Before
the first build, a 64-zero placeholder may be used **locally only**. Replace it
with the returned digest, set the exact planned GitHub Release asset URL, and
verify the uploaded bytes before submitting. The packer does not rewrite package
metadata or certify that the metadata's original digest matches its output.

Repeat for each declared platform. Do not declare platforms you have not built
and tested. The eventual official platform support policy is a separate gate.

## Prepare a bundle from Cadencr (E2)

For a project explicitly marked as a provider, open **Project Settings → Prepare
a local provider bundle**. This is separate from the readonly readiness checks.

1. Supply your managed package JSON, not the local host descriptor. The provider
   ID must match the project's plugin ID. Choose the publisher, exact version and
   planned release URL yourself; Cadencr does not infer them.
2. Declare exactly one binary target in this metadata and select that target.
   Its archive URL must end in `.tar.gz` or `.tgz`. A 64-zero SHA-256 placeholder
   is accepted locally; the exported metadata receives the computed digest.
3. Supply an absolute, dedicated staging directory outside the project tree.
   Do not use the home directory, a source checkout, or a symlink. Review every
   file for credentials and leave staging unchanged throughout preparation.
4. Acknowledge the review and prepare the bundle. Cadencr writes `provider.tar.gz`
   and `package.json` to a new unique directory under the settings directory's
   sibling `provider-publication-bundles/<project-id>/`. It displays both paths,
   the SHA-256, compressed size and target. Original inputs remain unchanged.

This local Rust implementation does not require Node in the desktop runtime.
It does not build or execute the connector, write Git state, upload files, create
releases, sign a catalog, or submit a registry contribution. Packaging is not
conformance approval or proof of source ownership. The secret-name denylist and
filesystem change detection are not an OS sandbox or a secret-content scanner.

Limits match the managed installer: 4,096 entries, 512 MiB expanded content,
256 MiB per file and 256 MiB compressed archive. Metadata is limited to 64 KiB.
Only one preparation runs at a time; failures surface without overwriting prior
bundles. At most 16 bundles are retained globally (at most 4 GiB of generated
compressed archives, plus metadata). At the limit, preparation refuses with the
storage path and asks you to review and manually remove old bundles; nothing is
automatically deleted. The storage scan also stops at 256 project directories.
Closing the dialog or disconnecting does not cancel an accepted preparation: its
completed bundle may remain in that directory and count toward the same limit.
Reproducibility applies to identical inputs with the same runtime, not guaranteed
byte equality between the Node CLI and the Rust implementation. Multi-target
metadata assembly and registry contribution remain later steps. The six selectable
target keys are not a platform-certification claim.

## Review and publish the author GitHub release (E3)

E3 publishes one previously prepared E2 bundle. Before starting:

- use an existing public GitHub repository and configure Cadencr's GitHub
  connection with an account that has push access;
- keep the project Git worktree clean, with `origin` pointing to the exact
  `github.com/<owner>/<repository>` declared by the package metadata;
- push the source commit and release tag yourself. The remote tag must already
  resolve to the clean local `HEAD` commit; Cadencr does not push source or create
  tags;
- retain the E2 bundle UUID. Only one binary target is supported by this flow.

In **Project Settings → Prepare a local provider bundle**, enter the prepared
bundle UUID and release notes, then choose **Review GitHub publication**. Review
does not write to GitHub. It reloads and validates the app-owned bundle and shows
the exact destination, connected actor, tag, source commit, archive name/size and
digest, metadata digest, target, version, channel and release notes.

The returned fingerprint binds that plan to the connected actor and immutable
GitHub repository identity. Changing the UUID or notes invalidates the review.
Publishing requires a separate checkbox confirmation of the displayed plan; the
service recomputes and compares the fingerprint before any write.

Publication creates or reconciles a GitHub draft, uploads exactly the archive and
`package.json`, and then publishes the release. It never replaces or deletes
assets, overwrites a foreign release, creates a repository/tag, or pushes source.
Lost API responses are reconciled, and an exact completed release can be retried
without new writes. Missing draft assets can be resumed; conflicting, duplicate,
incomplete published releases or remotely changed state fail closed and require
investigation rather than destructive repair.

Asset verification checks GitHub's reported asset name, size, state and `sha256`
digest. It does **not** independently download the public asset bytes. GitHub API
and upload hosts are fixed, redirects are disabled, credentials are not forwarded,
and local/remote reads, request sizes, pagination, timeouts and concurrent release
operations are bounded.

Local integration tests and isolated live-app QA passed. Positive publication and
retry coverage uses localhost GitHub fixtures, not a live GitHub release. Protect
tags and releases against external changes: these rechecks are not an atomic
transaction or proof of source-to-binary provenance or connector conformance.
E3 does not sign or publish the Cadencr catalogue and does not open a registry PR.

## Export a local registry contribution (E4)

After reviewing the exact E3 plan and publishing the matching GitHub release,
separately confirm **local file creation and read-only GitHub verification**, then
choose **Prepare registry contribution**. E4 reloads the bundle, project Git state,
connected actor and repository/tag state and recomputes the E3 fingerprint. If any
bound input changed, return to **Review GitHub publication** first.

E4 makes only GET requests to GitHub. It requires the exact release to be published
and verifies both assets by name, size, upload state and GitHub's native `sha256`
digest. A missing, draft, incomplete or conflicting release is refused. This is not
an independent download of the public asset bytes and performs no remote mutation.

Each attempt requires a fresh explicit confirmation. A successful action creates
a fresh directory:

```text
provider-publication-contributions/<project-id>/<uuid>/
  packages/<provider-id>-<version>.json
  submissions/<provider-id>-<version>.json
  PULL_REQUEST.md
```

The root is a sibling of Cadencr's settings directory. The package file preserves
the exact managed metadata, including unknown fields. The submission file uses the
existing `provider-submission-v1` envelope: `schema_version: 1`, the package object,
the pinned source repository/commit/tag, and the release notes as `changelog`. It
is not a new local draft schema. Cadencr applies the marketplace submission delta
rules before writing; production Node is not required.

Review `PULL_REQUEST.md` and every generated JSON file. Its generated facts are
filled in, but human claims remain unchecked: repository/provider authorization,
credential absence, native runtime and prompt-free conformance, license/provenance,
dependency or privilege changes, and official registry validation.

Exports use exclusive writes and are never overwritten or automatically deleted.
Ordinary write failures attempt cleanup, but process interruption can leave a
partial UUID directory that counts toward the quota and requires manual inspection
and removal. Every action intentionally creates a new UUID rather than reusing a
prior result. Only 16 exports are retained globally; archive any contribution that
must be retained outside this storage, then manually review and remove old or
partial exports before trying again.

E4 stops at local files. This local export action does not fork, branch, push,
open a pull request, sign, or obtain registry acceptance. It
cannot establish first/new-version status or continuity against the authoritative
registry baseline. Official registry CI and maintainer review remain required.

The local export passed unit/integration checks and isolated live-app error-path
QA. Successful remote verification/export remains tested with localhost fixtures,
not a real GitHub release.

## Registry pull-request policy

The accepted official contribution destination is
`merkr-software/cadencr-registry`. Contributions use a personal fork, a dedicated
branch and a pull request, never a direct push to the official default branch.
Registry CI and maintainer approval remain required before publication.

After the author release is published, select **Review registry submission** in
project settings. Check the registry destination, account, pinned base commit,
branch, version, exact file paths and notes. Confirm the displayed plan, then
select **Create registry pull request**. This confirmation is consumed on every
attempt. Local export alone never triggers a remote write.

Cadencr revalidates the bundle and published release, verifies or creates your
personal fork, prepares both metadata files in a single commit and opens a PR.
It verifies the candidate before creating the branch and verifies remote state
again afterward. An exact existing open PR can be reused; foreign branches,
closed PRs, existing version paths and changed plans are rejected. The app never
forces a branch, pushes to upstream, merges, approves or publishes the registry.
It does not grant maintainers permission to change your fork branch through the
PR. Full registry policy and publisher continuity remain CI/maintainer decisions.

Timeouts can leave a fork, unreachable Git objects, a branch or even a PR. Inspect
GitHub before retrying with fresh confirmation; no automatic destructive cleanup
runs. If the upstream base changes, review a new plan; it may use a new branch.
Old branches and PRs are not automatically rebased, closed or deleted. These checks
are not an atomic transaction with changes made by other GitHub actors.

Repository provisioning, branch protections, workflow deployment and real GitHub
acceptance tests remain separate deployment gates. Local fixture success does not
establish real token permissions, deployed CI or official registry availability.

## Prepare the review submission

Pin the source commit and release tag, record the changelog, and embed your final
managed package metadata in the submission envelope described in `CONTRIBUTING.md`.

```bash
npm run validate:submission -- /path/to/submission.json
```

The command checks source/asset URL consistency without fetching or executing
anything. Maintainers must still verify repository ownership, tag-to-commit
resolution, checksums, build provenance, license and code changes. A public
registry, signing environment and protected publisher are not provisioned by
these local commands.
