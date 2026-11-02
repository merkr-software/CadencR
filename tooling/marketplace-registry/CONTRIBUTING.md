# Contributing a Provider, Theme or Custom Tab

## Before public activation

The next milestone populates reviewed themes and Pi before a separately authorized
desktop activation. Local validation is not publication authority. All business
validation/packaging/publication uses the Rust CLI, not registry JavaScript.
Standalone preflight and expiry commands are included in the locally selected,
qualified `0.15.4`. Selection does not deploy the production
workflow or grant publication authority.
See [runtime and deployment gates](README.md#status-and-runtime).

## First submission

1. Build and test the plugin in Cadencr. Do not embed credentials, tokens or private
   keys in its metadata, archive, arguments or environment declarations.
2. Stage distributable files only and use the appropriate Rust packaging command.
3. Publish immutable assets in your public author repository. Record each exact
   SHA-256, full source commit and release tag; never submit placeholders.
4. Add `packages/<plugin-id>-<exact-version>.json` and the matching
   `submissions/<plugin-id>-<exact-version>.json` to a registry PR.
5. Validate the complete candidate against the accepted base with trusted Rust
   tooling, then request maintainer ownership/provenance and security review.

| Kind                             | Validate locally                                                                                                     | Package                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP provider                     | `cadencr plugin validate <folder> --descriptor <descriptor.json>`                                                    | `cadencr registry pack-provider --package <metadata.json> --target <target> --directory <staging> --output <new.tar.gz>` for each declared target                                            |
| Declarative theme                | `cadencr plugin validate <folder> --kind theme`                                                                      | `cadencr registry pack-theme --directory <staging> --output <new.tar.gz>`                                                                                                                    |
| Custom tab                       | `cadencr plugin validate <folder> --kind tab`                                                                        | `cadencr registry pack-tab --directory <compiled-staging> --output <new.tar.gz>`                                                                                                             |
| Custom tab with a native backend | `cadencr plugin validate <folder> --kind tab` (runs this platform's backend through the protocol conformance checks) | `pack-tab` for the web archive, then `cadencr registry pack-tab-backend --directory <tab-folder> --target <platform> --output <new.tar.gz>` for each platform in `tab.json` `backend.binary` |
| Multi-export plugin              | `cadencr plugin validate <folder> --kind plugin` (`plugin.json`, then each member with its own kind's validator)     | Each member with its own kind's command above, every archive in one author release; see [Multi-export plugins](AUTHORING.md#multi-export-plugins)                                            |

Providers must implement the documented executable/ACP contract and pass native
runtime/conformance tests on every declared platform. A theme remains declarative
with no ACP execution surface. A tab declares reviewed permissions/origins and
contains its built distribution, not an arbitrary source checkout. Packaging is
inert; it does not run a build or prove a plugin safe.

A tab with a native backend runs native code with the user's rights, so it
follows the provider regime: the submission pins the source repository, full
commit and tag; the web archive and every backend archive are `.tar.gz` assets
of that one author release (`tab.distribution.binary.<platform>` = `{archive,
sha256, size, cmd, executable_sha256, executable_size}`, copied from
`pack-tab-backend`'s output); `tab.backend` repeats `tab.json`'s `protocol` and
`reasoning`. Platforms are `darwin-aarch64`, `darwin-x86_64` and
`linux-x86_64`; a backend archive is at most 64 MiB and its executable at most
128 MiB. Staging verifies each archive's digests, its single 0755 entry and its
native format (signed arm64 code on Apple silicon) without executing it. Build
attestation is recommended but advisory in v1.

```sh
# Next qualified release required for the standalone submission command.
cadencr registry validate-submission /path/to/submission.json
cadencr registry validate --base /path/to/base --candidate /path/to/candidate
```

Use the [CLI contract](../../packages/cli/README.md) for the exact kind-specific
submission envelopes. Legacy providers use schema 1; mixed entries/submissions use
explicit schema-2 kinds. The reference schemas alone do not implement the complete
semantic policy. Maintainers separately check that the source tag resolves to the
pinned commit, inspect build provenance and confirm the submitter's authority.

## Updating a plugin

1. Increment to a new exact semantic version; build/test and publish new immutable
   author assets.
2. Add the new package and matching source-pinned submission in a new registry PR.
3. Run the same base/candidate validation and independent maintainer review.

Previously accepted versions cannot be modified or removed through this path.
Changing JSON whitespace/key order is not a semantic change; changing a checksum,
URL, permissions, publisher or any other metadata value is. Correct mistakes with
a new version, never by replacing accepted assets or metadata. The publisher also
checks continuity against the authenticated prior signed catalog.

## Identity, ownership and licensing

- IDs use `^[a-z][a-z0-9-]*$`; normalized collisions and reserved identities fail.
  The migrated `cursor` identity is accepted only for the official `cadencr`
  publisher from a `merkr-software` repository, with an explicit minimum host
  version of `0.16.0` or newer. Other built-in identities and normalized
  lookalikes remain reserved.
- New identities require proof of authority over the linked source project.
- The `host.publisher` value `cadencr` (any letter case) is reserved for the
  official `merkr-software` GitHub organisation. A package or submission that
  claims it from any other source repository fails validation and is never
  signed into the catalog.
- A normal version PR cannot silently transfer publisher/source ownership.
  Transfers need a separate explicit administrative procedure and independent
  evidence; there is no ordinary contribution bypass.
- Declare the required license/provenance and include the distributable license
  and documentation. Review dependencies, privileges, setup and all target bytes.
- Acceptance is not a safety certificate or a promise of permanent listing.
- The first version that introduces `backend` for an existing tab id needs
  new-identity review (source authority, build provenance, every platform's
  binary), as if the tab were new: it turns a page into native code.

After approval, the protected registry publisher mirrors the exact archives to
registry-owned GitHub Releases and publishes the signed catalog. Authors do not
receive registry signing authority. No PR check executes contributor binaries or
proves which source produced an archive.

## Security reports

Do not report vulnerabilities in a public PR; follow [SECURITY.md](SECURITY.md).
Maintainers may reject, delist or revoke malicious, compromised or otherwise
unacceptable packages. Catalog discovery and signed revocation are distinct
controls; incidents require the protected operator procedure.
