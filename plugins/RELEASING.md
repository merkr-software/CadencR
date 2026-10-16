# Independent official plugin releases

## Scope

- Tags: `plugins/provider-pi/v0.4.0`, `plugins/theme-graphite/v0.1.0`,
  `plugins/theme-ember/v0.1.0`, `plugins/theme-fjord/v0.1.0`.
- Never use desktop `v*` tags. Plugin versions do not change app versions.
- `release-policy.json` records theme source versions because theme documents have
  no package version. Pi uses its own `package.json` version.
- This preparation adds no tags, releases, registry entries or marketplace activation.

## Preparation contract

The workflow checks the exact tag's commit and official tracked source paths.
It downloads only the checksum-pinned **production released CLI** using the shared
fetcher. `PENDING` pins fail the job; no qualification-pin or source-build fallback.
The canonical CLI validates and packs each theme twice and exact bytes must match.
Only `theme.json` is staged. Pi preparation refuses to invent native targets or
package metadata while those decisions remain pending.

Public output is limited to the archive, `SHA256SUMS` and `release.json`, which
binds tag, version, source path, full source commit and archive digest/size. CLI
receipts containing private runner paths, logs, keys and environment are excluded.
This is preparation metadata, **not** a registry package or signed author submission.
Namespaced tag URLs must eventually be encoded by shared registry tooling.

## Closed publication gate

No publisher job or signing secret is wired. This workflow is preparation-only.
A future publisher must use a protected environment with required reviewers and
restricted tag deployments; only that job may request `contents: write`.

Before implementing publication, review:

- [ ] Source licenses and Pi artwork provenance.
- [ ] Pi supported native targets and canonical registry package metadata.
- [ ] Generic-host conformance and real supported-platform behavior.
- [ ] Distributed CLI publication/resume/recovery/renewal qualification.
- [ ] Production CLI pin promotion and registry cutover.
- [ ] Protected signing authority and author-publication policy.

Environment approval alone cannot resolve these decisions. Future signing and
publication must use the shared released Rust CLI and revalidate the exact artifact
and source binding; do not introduce an alternate JavaScript publication path.

## Offline qualification preparation

`sh scripts/official-plugin-release.sh --qualification <repo> <commit> <tag> <new-absolute-output>`
uses the existing qualification pins and labels the output `authority: qualification`.
This explicit read-only mode grants no production signing or publication authority;
the tag workflow never enables it. It still requires an existing source-bound tag.

## Repository authority and private scratch

Both modes require the checkout origin to identify `merkr-software/CadencR`.
Production also requires matching `GITHUB_REPOSITORY`, `GITHUB_SHA` and
`GITHUB_REF` tag context; qualification requires no GitHub execution context and
never grants production authority. Public metadata records the canonical repository
identity, never the local checkout path.

Private scratch is retained and its path printed to stderr on packaging attempts.
There is no recursive cleanup: an unexpected database created in CLI HOME must
not be deleted. Review retained scratch separately; never upload it.
