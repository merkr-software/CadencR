# Cadencr CLI

`cadencr` is headless, offline tooling for validating provider packages and
building a local registry index. It never contacts the service or database,
uses the network, installs a plugin, or executes a provider binary.

## Commands

```text
cadencr plugin validate <folder> --descriptor <descriptor.json>
cadencr registry validate --base <directory> --candidate <directory>
cadencr registry build-index --packages <directory> \
  --generated-at <timestamp> --expires-at <timestamp> [--output <new-file>]
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

## Diagnostics and exit codes

Pass `--json` for one structured diagnostic object. For `build-index` without
`--output`, stdout remains the index JSON itself; failures are still structured
JSON on stderr. Help and version retain clap's human-readable output.

| Code | Meaning                                         |
| ---: | ----------------------------------------------- |
|  `0` | Success, help, or version                       |
|  `1` | Plugin or registry input failed validation      |
|  `2` | Invalid CLI usage                               |
|  `3` | The generated index could not be written safely |

## Migration status

The local validation CLI and Linux release/registry-CI wiring are implemented.
The registry still uses its JavaScript gate until a real release version and
SHA-256 digest are provisioned in the trusted pin file. No release is implied by
building this crate locally.

Numeric canonicalization matches JavaScript and is covered by a deterministic
263-case Node oracle. The app's legacy signature verifier is not changed by this
increment: signing compatibility must be resolved before enabling catalog
publication. These commands do not sign or publish a catalog.

## Initial release runtime

The first downloadable Linux binary targets the registry's Ubuntu 24.04 x86-64
CI runners, matching its build and execution-smoke environment. Its GNU target
name is not a promise of compatibility with older Linux distributions. General
CLI platform distribution remains outside this initial registry-only release.
