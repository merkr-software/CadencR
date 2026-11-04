# Pi provider retirement and namespace handoff

Decision recorded on 2026-11-04: retire the first-party Pi implementation in favor
of [edjubert's connector](https://github.com/edjubert/cadencr-plugin-provider-pi),
with provider ID `pi`, display name **Pi**, publisher `edjubert`, and the author's
own source repository. The
[maintainer comment on registry PR #22](https://github.com/merkr-software/cadencr-registry/pull/22#issuecomment-6630319571)
records the namespace authorization and requests a new immutable renamed release.

## Source retirement

The CadencR change removes `plugins/providers/pi`, its package scripts and
lockfile importer, its native qualification workflow, and its official release
policy entry. Remaining plugin checks cover Cursor and themes. Historical QA
reports, tags and published release assets retain their original meaning.

This source change does not uninstall existing managed providers or rewrite
conversation identities, session IDs, receipts, or user databases.

## Candidate verification

| Item                      | Observed on 2026-11-04                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Open registry PR          | [#22](https://github.com/merkr-software/cadencr-registry/pull/22), head `a1f2aa6684ba4be0ccb7bdb962b2a385b2ee84d7`                  |
| Actual PR files           | `packages/pidancr-0.2.0.json`, `submissions/pidancr-0.2.0.json`                                                                     |
| Registry checks           | `inert-metadata` and `contributor-tooling` passed for that head                                                                     |
| Latest release checked    | [`v0.2.1`](https://github.com/edjubert/cadencr-plugin-provider-pi/releases/tag/v0.2.1), GitHub `immutable: true`                    |
| Source/tag binding        | `v0.2.1` resolves to `5a28d3feda63ac8ed327d3696a7f48e21f5639d3`, matching the released submission                                   |
| Author CI                 | [Run 41814529310](https://github.com/edjubert/cadencr-plugin-provider-pi/actions/runs/41814529310) succeeded for that source commit |
| Public assets             | All eight downloaded; SHA-256 values match GitHub asset digests                                                                     |
| Package consistency       | Released package equals the submission's package; four archive hashes match its distribution metadata                               |
| Static archive inspection | Four targets: no absolute/traversal paths, duplicate entries, links, special files or setuid/setgid permissions                     |

The PR title/body describe `0.2.1`, but its current files still submit `0.2.0`.
The renamed candidate must update both files and rerun its own checks. Published
`pidancr` assets must remain immutable. A renamed version greater than the retired
`pi 0.4.1`, such as `0.5.0`, avoids ordering the replacement below installed
first-party versions.

No contributor executable was run during this verification. The author reports
native macOS arm64/Intel and Linux arm64/x86-64 qualification with Pi `1.5.0`;
those runtime tests were not independently repeated. Signed installation,
packaged desktop lifecycle, and compatibility with the old connector's saved
sessions remain unverified.

## Production registry work still required

Tracked in [registry issue #23](https://github.com/merkr-software/cadencr-registry/issues/23).

The accepted registry contains `pi 0.4.0` and `pi 0.4.1`, owned by `cadencr` and
sourced from `merkr-software/CadencR`. Ordinary contribution and publication paths
enforce immutable history and stable ownership:

- `packages/registry-core/src/lib.rs` checks accepted contribution history.
- `packages/registry-core/src/snapshot/continuity.rs` rejects removal or mutation
  of previously signed packages and publisher/source ownership changes.
- `packages/registry-core/src/catalog.rs` rejects conflicting owners in a catalog.

Deleting the four package/submission JSON files alone cannot delist the signed
catalog or transfer the namespace. Administrative tooling must represent the
explicit retirement/transfer, preserve verifiable history, and publish a verified
successor through the protected registry workflow. The normal checks remain in
force. Revoking an entire `pi` identity would also affect the replacement and is
not an appropriate substitute.

The existing CLI was run against an isolated candidate with those four files
removed. It rejected all four with `deletion is not allowed`. The released
`0.2.1` package and submission separately passed inert CLI metadata validation.

- [x] Remove the first-party implementation and its publication allowlist.
- [x] Record maintainer authorization and ask the author to rename to `pi` / Pi.
- [x] Verify the public `0.2.1` release and identify the PR/version mismatch.
- [ ] Receive a new immutable renamed candidate and review its source/artifacts.
- [ ] Implement and qualify explicit administrative delisting/ownership transfer.
- [ ] Withdraw the old listing and publish the replacement signed catalog.
- [ ] Verify marketplace installation on supported macOS and Linux clients.
