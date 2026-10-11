---
name: Provider version
about: Submit immutable metadata for one provider version
---

## Identity

- Provider ID:
- Version:
- Publisher/maintainer GitHub handles:
- Source repository:
- Source commit (full SHA):
- Release tag:

## Contribution files

- Package: `packages/<provider-id>-<exact-version>.json`
- Source-pinned submission: `submissions/<provider-id>-<exact-version>.json`

## Artifacts

| Platform | Release asset URL | SHA-256 |
| -------- | ----------------- | ------- |
|          |                   |         |

## Review notes

- Native CLI prerequisite and authentication/setup documentation:
- License and provenance:
- User-visible changes:
- Dependency or privilege changes:

## Checklist

- [ ] I added both the managed package and its matching source-pinned submission.
- [ ] I control or am authorized to publish the linked project and provider ID.
- [ ] The submission pins a full source commit, exact release tag, and non-empty changelog.
- [ ] The source revision and every archive are immutable and exact-versioned.
- [ ] Every checksum was calculated from the linked release asset.
- [ ] Archives contain no credentials; users authenticate through the native CLI.
- [ ] `version`, model discovery, ACP v1 runtime, and prompt-free conformance pass.
- [ ] I ran `npm test`, `npm run validate`, and the contribution validator locally.
- [ ] I understand CI validates inert metadata only; maintainers separately verify publisher authority and provenance.
- [ ] I understand maintainers review executable changes and may reject or revoke a version.
