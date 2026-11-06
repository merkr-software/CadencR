# CLI 0.15.6 LSP qualification — 2026-11-06

## Qualification status

The exact public ELF passed distributed offline checks, author publication and
independent recovery, additive registry publication, unchanged-set renewal and
the LSP policy lifecycle. The 25-package released-CLI catalog matrix remains
pending. These CLI checks do not grant production publication authority.

The CLI is published independently of Cadencr Desktop. Production LSP catalog
admission and feed activation remain held for application `v0.16.1`.
This delivery does not publish an application release.

## Distributed binary

| Binding | Value |
| --- | --- |
| Public release | [cli/v0.15.6](https://github.com/merkr-software/CadencR/releases/tag/cli/v0.15.6), release ID `436405263` |
| Source commit | `33abe673179a889c7ec362da2e9845166de1ac34` |
| Build and publication | [42207612393](https://github.com/merkr-software/CadencR/actions/runs/42207612393), attempt `1`, success |
| Binary | `cadencr-v0.15.6-x86_64-unknown-linux-gnu`, 6,531,352 bytes |
| Binary SHA-256 | `0d95aec0e56f1957d7e928226208fb2d987666b0713678e66ef5798a5ec16623` |
| Checksum list SHA-256 | `63523f5737fec8a8ed4fe5b122d0d598b31dbbf2efd3b04ce542a02ef4e3398d` |
| Public pin file SHA-256 | `a7b955fb6967921f07da0ff25f4236dc13208e7cb7580f917c5787d119c9cae4` |
| Provenance SHA-256 | `d3075d8ac81b878250f54317dc3c1b3465219de733a75a8d60dcf5cf53fe97fc` |

All four assets were fetched through anonymous public URLs and compared
byte-for-byte with the actual publication candidate. The tag and provenance
bind the source above. GitHub reports the release immutable, public and stable;
the application Latest remains `v0.16.0`.

These are actual publication hashes. Source-built and release dry-run hashes
are not substituted for distributed-binary evidence.

## Offline and author evidence

The initial offline and author workflow source is
`e30e43388c5a9ee1b9b4ffe3ff3c04018b5ede96` in
`merkr-software/cadencr-registry-qa` (repository ID `1420296872`). Runs below
use the actual public ELF, with no source fallback. Both offline proofs retain
`lifecycle_qualified: false` and `production_pins_changed: false`.

| Gate | Run, attempt `1` | Evidence SHA-256 |
| --- | --- | --- |
| General offline, 91 checks | [42208668469](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42208668469) | `b14cd2f52516f768fa158b79cadf79865b98cdca74a04d51923689e85bf1d358` |
| LSP offline, 129 checks | Same run | `38ff4f935e1abd39345c087382673e5a95ac088ccda90907ea82a8f43091308b` |
| LSP author inspection | [42208675951](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42208675951) | `98949c72b2df6f3fa132e4882507b6a34e5d02aef98811f868ccb8e10e14a154` |
| Author publication and interrupted-draft resume | [42208862735](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42208862735) | `f2a35dc81667950ea8188d23ab87dca7c639b262a27a3673d6876436cee4b28d` |
| Author independent fresh runner | [42209433459](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42209433459) | `9d35397e219b217726c2eb9b5dc2372380fe5a1ee5bff2d82421f3570a581863` |

The LSP supplement binds public pin SHA-256
`a7b955fb6967921f07da0ff25f4236dc13208e7cb7580f917c5787d119c9cae4`,
provenance SHA-256
`d3075d8ac81b878250f54317dc3c1b3465219de733a75a8d60dcf5cf53fe97fc`
and the CLI source above. Synthetic native fixtures are never executed and do
not prove native runtime conformance or managed-client revocation enforcement.

The inert author `qa-author-lsp` fixture is version `1.0.1`, declares minimum
application `999.0.0` and is never executed. Its source commit is
`3ad1af383861c4d4a97222847c65a947d625b5ae`, tagged
`qa-author-cli/stable-0156-lsp-42207612393-1` in the fixed QA repository.

Author publication binds request SHA-256
`a9bedab96e03330c4edc07c147c8eab8920d0d57f88bcc68fb3e9e7e6dc425c3`
and release ID `436410179`. The harness observes and terminates an empty draft,
then resumes the same release ID. Two completed retries preserve the same three
assets. Changed bytes and changed requests are rejected without altering the
inventory. The independent fresh runner then verifies the same release ID,
request and all asset IDs, sizes and digests, including two completed retries.
Its proof reports `interrupted_draft: not_exercised`, preserving the first run's
separate interruption claim.

## Registry campaign

[Additive publication run 42209917316](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42209917316),
attempt `1`, passes publication and same-state replay on first and independent
fresh runners. The signed catalog is byte-identical in all four receipts,
SHA-256 `160d7ea20d78fd10ea5fd8b78bf0b3633cfeacbd0f49f20289ba66fd0a318e45`.
It contains 28 packages and 53 archives and preserves the exact 27 historical entries.

The campaign input commit is `b28554c40676efb5f8bd750273ca6950cf70b559`.
The reviewed request SHA-256 is
`e486c725c349010ad8d0b114939e6a257a89488434ad6d645b318ac2dd9f556a`
and plan SHA-256 is
`d3d43044d8572cd90df6eb22708b6222cddc79ce1e160b8b0c52e8094d2540a3`.
All four receipts bind the distributed ELF above. No registry interruption is
inferred from the separate author interruption test.

[Unchanged-set renewal run 42211832866](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42211832866),
attempt `1`, uses reviewed QA commit `d19cbf58949ecef6b5578518d4dc2fed58f929a2`.
First and fresh runners each perform renewal and same-state replay. All four
retain identical release inventories and signed catalog bytes, with the exact
same 28 packages and 53 archives; no mirror or package publication is performed.
Only catalog dates advance. Final index SHA-256 is
`0e01e107db2827313de4b7b720ae80fe25e7c7038cf2bf585d7f5d65da3776d5`,
at discovery head `54d4ee28aea259fc483f6dc3bbcb4fe2a1c02400`.
The distributed CLI independently authenticates those public signed bytes.

| Renewal receipt | SHA-256 |
| --- | --- |
| First runner | `3f0043e513f8791cad55aadf5cd210df7bbbb5f23a75c98821284790e2a5fc99` |
| Fresh runner | `b894a34d3913d0c8e1adbe2ba94d73eb5cd6be442a211a05f5c5b0534588db6b` |

## LSP policy lifecycle

The initial [policy run 42210723838](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42210723838)
failed before signing or publication because the dedicated QA policy branch
did not exist. Its failed result is retained. Provisioning that new branch at
reviewed QA commit `d19cbf58949ecef6b5578518d4dc2fed58f929a2` is a harness
prerequisite; it does not change the distributed CLI or the reviewed request
bytes.

[Retry run 42210995535](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/42210995535),
attempt `1`, passes bootstrap, renewal, same-state replay and rejection of older
policy bytes in both plain and renewal modes. Proof SHA-256:
`ebfe2a0c222c71f83bac2feaaf421d0ab5a94db11007314fe54cf3abb785bf53`.

The bootstrap policy SHA-256 is
`73617770deeb417a4244c69a1488706a758ae23844dcfa8e4fce484686374d26`.
Renewal advances it to
`945c6ccedc7a7c982ca5e281510e38c9f984080d1520d8e7b5be1070afd7fb95`
at branch head `2ffb18028170752155ff8199ab8cea9b5f087bda`.
Replay and both rejected rollbacks preserve that head and exact policy bytes.
The catalog stays byte-identical at
`160d7ea20d78fd10ea5fd8b78bf0b3633cfeacbd0f49f20289ba66fd0a318e45`,
and all 83 release inventories are unchanged. This QA branch is separate from
the production LSP feed.

## Retained public proofs

The immutable [proof manifest](https://raw.githubusercontent.com/merkr-software/cadencr-registry-qa/cfb92d0c9232aabdd7c6ea417a1f63179ac4fe70/requests/cli0156/proofs/manifest.json)
at reviewed QA merge commit `cfb92d0c9232aabdd7c6ea417a1f63179ac4fe70`
retains 33 key-free files and the ledger for 12 verified artifact ZIPs. Manifest
SHA-256 is
`945ba5a2f06760b733185018464b7d5a469ac31d7a81de3b44d2024d492e03f5`.
It distinguishes distributed CLI source, inert author source and the actual QA
workflow commits, and preserves the initial policy failure separately from its
successful retry. These receipts preserve evidence beyond Actions retention;
they do not serve as publication or recovery authority.

## Coherent local CLI selection

The three monorepo pins select this exact qualified version, ELF and tag:
`scripts/cli-qualification.env`, `scripts/official-plugin-author-cli.env` and
`tooling/marketplace-registry/ci/released-cli.env`. Their identical checked file
bytes have SHA-256
`6f891edf30a2678b86eb55296d99184dc5a7f43f4a7d7c7416d3f5227289ff12`.
This includes reviewed source comments and therefore differs from the public
release's minimal pin file digest.

The author qualification JSON has SHA-256
`bfc2c11e48cd314a09b050577cedbbafb7ef4328fbf27159e86e2637d0ea0a02`.
The author policy binds both exact file digests and retains its reviewed
repository, account, environment and reviewer requirements.

## Released catalog matrix pending

Canonical packaging of all 25 packages and their four-host semantic matrix must
run from reviewed `main` with `cli_mode=released` after this pin selection lands.
The earlier [source-built candidate run 42037164906](https://github.com/merkr-software/CadencR/actions/runs/42037164906)
passed all 25 packages on Ubuntu 22.04, Ubuntu 24.04, macOS ARM and macOS Intel.
Its provenance is `source-build`; it does not qualify this public ELF.

## Production boundary

- The local template selection does not deploy the production registry or
  modify its operational CLI pin.
- The shared production catalog retains no LSP entries. Its LSP feed stays
  unset until the reviewed application cutover.
- Direct-server semantic tests remain distinct from managed application
  install, update, remove and revocation qualification.
