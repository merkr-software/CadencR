# Cadencr Marketplace Registry Template

This directory is a portable bootstrap for the GitHub-only registry described in
`docs/MARKETPLACE_V1.md`. It is a template, not a deployed registry, and contains
no production URL, trust key, credential, or remote resource.

## Repository layout

| Path                                | Purpose                                                        | Trust domain                           |
| ----------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `packages/*.json`                   | One reviewed `ManagedProviderPackage` per provider version     | Contributor PR input                   |
| `schemas/`                          | JSON Schema documents for package and signed-index shape       | Public validation                      |
| `scripts/validate.mjs`              | Dependency-free semantic validation matching managed index v1  | Unprivileged CI                        |
| `scripts/build-index.mjs`           | Deterministic sort and canonical unsigned index creation       | Unprivileged CI or protected publisher |
| `scripts/assemble-signed-index.mjs` | Joins a detached signature to the exact canonical payload      | Protected publisher only               |
| `.github/`                          | PR form and example workflows to copy to a registry repository | Repository bootstrap                   |

## Local checks

Requires Node `>=22.19.0 <23.0.0`.

```bash
cd tooling/marketplace-registry
npm test
npm run validate
npm run validate:submission -- /path/to/submission.json
npm run build:index -- \
  --generated-at 2026-09-12T00:00:00Z \
  --expires-at 2026-09-19T00:00:00Z \
  --output /tmp/managed-index.json
npm run assemble:index -- \
  /tmp/managed-index.json \
  /secure/path/signature.json \
  /tmp/signed-managed-index.json
```

`build:index` requires an explicit publication time and expiry (at most 14 days
later) and writes only the unsigned `ManagedProviderIndex`. Signing is a
separate protected operation. The signing system must sign the exact bytes in
that output (without a trailing newline); it must never download or execute provider archives.
`assemble:index` only validates and joins the unsigned payload with a detached
signature document; it does not sign or publish anything.

The tests and fixtures travel with this directory when copied into a standalone
registry repository. Cadencr root tests additionally check that these fixtures
remain byte-identical to the service contract. Executable validation derives
allowed object fields from the schemas and adds host-specific semantic checks;
this is not a general-purpose JSON Schema engine.

## Deliberate limits

The source-pinned submission preflight is a separate author/reviewer command.
It does not change the managed package/index v1 wire format and does not prove
source ownership or reproducible-build provenance. See `CONTRIBUTING.md` for
the submission envelope and remaining human verification requirements.

- This template does not select the production repository, release URLs,
  supported-platform policy, signing service, or trusted key.
- It does not mirror artifacts or publish GitHub Releases.
- JSON Schema catches shape errors; `validate.mjs` is also required for semantic
  rules such as semantic ordering, HTTPS archives, reserved arguments, and the
  credential-field ban.
- Schema validation and conformance do not establish publisher trust or code
  safety. Maintainer review and protected publication remain mandatory.
