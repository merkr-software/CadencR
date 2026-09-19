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
