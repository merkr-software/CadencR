# Contributing a Provider Version

## Before opening a pull request

1. Implement and test `version`, `models --format acp-config-options-v1`, and
   `run --protocol acp-v1` as documented by Cadencr's provider package contract.
2. Configure and authenticate any native provider CLI outside the package.
   Never put credentials, tokens, auth methods, or private keys in metadata,
   archives, arguments, or environment entries.
3. Build immutable archives for each declared platform and publish them under an
   exact version in the author's repository.
4. Record the SHA-256 of each exact archive and pin the source commit and release
   tag in the pull-request description.
5. Add `packages/<provider-id>-<exact-version>.json`, using
   `packages/example-provider-0.1.0.json` as a shape example only.
6. Run `npm test` and `npm run validate` here. To exercise index creation, pass
   explicit `--generated-at` and `--expires-at` timestamps as shown in `README.md`.

## Identity and ownership

### Source-pinned submission preflight

Before review, prepare a `provider-submission-v1` JSON document containing:

- `schema_version: 1`;
- `package`: the existing managed provider package (its installation contract is unchanged);
- `source.repository`: the canonical `https://github.com/owner/repository` URL;
- `source.commit`: the full, lowercase 40-character source commit;
- `source.tag`: the exact release tag;
- `changelog`: a non-empty description of the version's changes.

Run `npm run validate:submission -- /path/to/submission.json`. This command is
local and inert: it does not fetch archives, execute code, contact GitHub, create
releases or submit a PR. Archive URLs must identify GitHub Release assets in the
declared source repository and tag. Public V1 submissions use built binary
archives, not package-manager installation at runtime.

The JSON Schema describes structure, not the complete acceptance policy. Always
run the semantic CLI as well: reserved identities, cross-field repository/tag
binding and Git ref rules cannot be inferred from a schema-only pass.

This preflight proves declared metadata consistency only. Reviewers must independently
verify that the tag resolves to the declared commit, inspect the source/build
provenance and check the submitter's authority. A checksum alone does not prove
which source produced an archive. Keep the source submission as review evidence;
the signed installation index continues to contain managed package entries only.

### Ownership review

- Provider IDs match `^[a-z][a-z0-9-]*$` and are permanently reserved by the
  first accepted contribution.
- A new ID requires proof that the submitter controls the linked source project.
- Versions are immutable. Correct a release with a new semantic version; never
  replace metadata or bytes for an accepted `id@version`.
- Ownership transfers require approval from the current owner and new owner. If
  the owner is unavailable, maintainers require independently verifiable project
  control and may hold or reject the transfer.
- Maintainers may reserve built-in IDs, aliases, confusing names, and IDs involved
  in an unresolved ownership or security dispute.

## Review and licensing

- Declare an SPDX license identifier in `agent.license` and include the package's
  license file through `host.assets.license`.
- Reviewers verify source revision, provenance, dependency changes, declared
  platform bytes, checksums, executable behavior, setup instructions, and native
  CLI prerequisites for every version.
- Automated conformance is evidence of compatibility, not a safety certificate.
- Submission does not guarantee acceptance, publication, or continuing listing.

## Security and takedowns

Do not report vulnerabilities in a public pull request. Follow `SECURITY.md`.
Maintainers may pause review, reject, delist, or revoke a package for malicious
behavior, compromised provenance, legal concerns, abandoned ownership, or policy
violations. Delisting affects discovery; execution revocation requires the
separate signed blocklist process.
