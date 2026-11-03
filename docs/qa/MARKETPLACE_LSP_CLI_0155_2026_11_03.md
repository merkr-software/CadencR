# CLI 0.15.5 LSP qualification — 2026-11-03

The CLI is published independently of Cadencr Desktop. Production LSP catalog
entries and build-feed activation remain held for application `v0.16.1`.
This delivery does not publish an application release.

## Distributed binary

| Binding | Value |
| --- | --- |
| Public release | [cli/v0.15.5](https://github.com/merkr-software/CadencR/releases/tag/cli/v0.15.5) |
| Source commit | `cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239` |
| Dry run | [41711815024](https://github.com/merkr-software/CadencR/actions/runs/41711815024) |
| Build and publication | [41712591610](https://github.com/merkr-software/CadencR/actions/runs/41712591610) |
| Binary | `cadencr-v0.15.5-x86_64-unknown-linux-gnu`, 6,514,176 bytes |
| Binary SHA-256 | `b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441` |
| Public pin file SHA-256 | `dfdcb3de13285e11b6f89b50d8f2da61a6119c5622e9cedb4e08432cde6780da` |

All four public assets were downloaded and compared byte-for-byte with the
publication candidate. The binary, checksum list and pin also match the dry run.
The tag and provenance bind the exact source above. The release is public,
immutable, not a prerelease, and not Latest. The application Latest remained
`v0.16.0` after CLI publication.

## Offline and author gates

All runs below use the exact distributed Linux ELF, without a source fallback.
The acquisition helper verifies assets without executing the binary. Offline
execution uses a network namespace, an empty environment and dropped privileges.
Only allowlisted key-free evidence is uploaded.

| Gate | Run | Evidence SHA-256 |
| --- | --- | --- |
| General offline, 91 checks | [41714090100](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41714090100) | `b7c693aeca8bba4954d04c918b3a8f75ac08a6c4d3166f587d155a8e6b752d91` |
| LSP offline, 32 checks | Same run | `2995771cf4ef1a5d7de66527ea3dd4443fb9b46441297ea6b59984f03f0a4101` |
| LSP author inspection | [41714112082](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41714112082) | `4f689c334e48ba821716f470da23194a5122b65a5f3035338a6f5fa181f83f4c` |
| Author publication and interrupted-draft resume | [41714469620](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41714469620) | `e66918cd536a79f164002d495371fcc3168b98b73cb324c3dfb2cbd0164278c8` |
| Author independent fresh runner | [41714892549](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41714892549) | `b68c8e0e3b4f30d1d5b2a6eddd2401f6e4f1bc63bd1e3d8a74dfad48e0d20928` |
| Exact ELF mirror-plan projection | [41716176016](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41716176016) | Bound by the registry campaign inputs |

The LSP supplement checks deterministic Node/native packaging, actual tar
membership and bytes, normalized permissions, refusal of overwrite, links,
traversal, changed digests and invalid runtime, mixed-index signatures, and
LSP-policy domain separation and signature tampering. Native files are synthetic
ELF/Mach-O headers that are never executed; these checks establish no native
server runtime conformance or client revocation enforcement.

The inert author source is commit
`33591d7b2f409b313fa0eadd9d1aedf709a625be`, tag
`qa-author-cli/stable-0155-lsp-20261103`, in the fixed QA repository
`merkr-software/cadencr-registry-qa`, ID `1420296872`.
Its `qa-author-lsp` version `1.0.0` declares minimum application `999.0.0` and
throws if executed. It is never run by the qualification harness.

Both public author proofs retain release ID `433192928`, the same three asset
IDs/digests and request SHA-256
`395c5175ba83df1a17004332837e04052fd7ea9d75480153bddb51fddb3886e1`.
The first run observes and interrupts an empty draft, then resumes the same ID.
Both runs verify two retries, including fresh scratch, and reject changed asset
bytes and changed requests without modifying the public inventory. The second
run does not repeat the interruption claim.

The generic author publication implementation is unchanged between qualified
`0.15.4` source `3ebb603160d9dcf054adbb6315c68cb8702cf7ce` and this `0.15.5`
source (`packages/cli/src/author_release.rs`,
`packages/registry-publisher/src/author_release.rs` and its sibling directory).
Together with the current ELF general offline and real LSP author gates, this
supports the local shared author-contract pin promotion. It does not claim a new
official provider/theme/tab publication; the earlier `0.15.4` record is retained.

## Registry and policy campaign

The additive registry campaign is restricted to QA, with exact request/plan
digests and a single LSP delta. Its real baseline has 26 packages and 49 archives
at discovery head `aa65373a655893cdb1f9d338350b0e0033f40c94`, exact-byte SHA-256
`33dc7a0c75533dd953e80be1d17d85045ad9706af268b8e603e1067c64ddf59f`.
The expired baseline is authenticated as history only; new indices remain subject
to strict freshness checks. No old input, release, tag or catalog is reset.

| Campaign | Run | Observed result |
| --- | --- | --- |
| Single additive LSP publication | [41717653667](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41717653667) | 26 packages / 49 archives become 27 / 51; all earlier releases and assets preserved |
| Unchanged package-set renewal | [41719150203](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41719150203) | 27 packages / 51 archives; 80 release inventories preserved |

Each campaign runs publication and same-state replay on two independent runners.
All four receipts per campaign retain identical inventories and signed catalog
bytes. No registry interruption is inferred from the author interruption test.

| Signed catalog | SHA-256 | Discovery head |
| --- | --- | --- |
| Additive publication | `e023a9d370f81de2feb647e01408f12b3b63e16052d8f35cbc047adf6660fd1b` | `0288a78f92dc2b5332db76351ede62655ee59019` |
| Renewal | `b9189c29393c17e3cfc8d2825e50d1a61333e8c46809087b780f21ae1e09b87f` | `b3db06ac53784f217fb87f9e9d7f41d4db9b8fa9` |

The original [LSP policy run 41720393138](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41720393138)
**failed**: the outer QA harness killed the renewal command after 300 seconds,
after the exact renewed policy had already been written remotely. The CLI permits
360 seconds for public-feed verification, so the harness deadline was too short;
the underlying cause of the wait is not established. The future QA deadline is
900 seconds. The published CLI binary is unchanged.

The original failed-run artifacts, request and Git parent chain are retained.
Bootstrap commit `47d6738e9f51c88bbe619773f9c72961811cab30` precedes renewal
commit `dae9d692569076e2f51143391b61b078b8f53c63`; live policy bytes match renewed
SHA-256 `59e218c0ca59b3f4b5b1cfa0df44c4e4eeb64ab499a68ccb927baf1c15846632`.
The recovery is restricted to replaying those exact already-live bytes, without
signing, bootstrap, new dates, catalog changes or release inventory changes.

[Recovery run 41725197485](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41725197485)
passed with the exact distributed ELF. Two replays return `unchanged`, fetched
signed bytes are identical, and two attempts to publish the older bootstrap are
refused (plain and renewal modes). The policy head, catalog and all 80 release
inventories remain unchanged. Recovery proof SHA-256:
`02da7220f7fc21a4975fe8f77b7e17be809d49c335e4632394c4cb6eff2cdb62`.
This reconciles the original remote result; the initial run remains failed.

## Held real TypeScript package

[Run 41714122497](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41714122497)
prepared real TypeScript language-server `5.3.0` with bundled TypeScript `6.0.3`.
It verifies exact official npm tarballs and their complete source-file inventory;
it runs no package-manager or lifecycle installation scripts.

| Prepared output | Value |
| --- | --- |
| Candidate package | `typescript-language-server`, version `0.1.0` |
| Minimum application | `0.16.1` |
| Node prerequisite tested | `22.19.0`; upstream requires Node `>=20` |
| Bundle | 145 regular files, 26,682,278 expanded bytes |
| Archive targets | `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64` |
| Each Linux-produced archive | 5,014,231 bytes, SHA-256 `295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286` |
| Source-lock SHA-256 | `dfd04ebc92a461bf968e65bdc78d421a956dec7dfce655d17531c5518769f387` |
| Preparation evidence SHA-256 | `799a80dd9e8a5fbfec731a3db743f6af4489489eca6d2ca4762e8658538a7a82` |

The actual Linux x86_64 stdio server passes initialization, bundled TypeScript
selection, diagnostic `TS2322`, hover and clean shutdown. The released ELF packs
each target twice with identical bytes, inspects all archive files, and validates
the manifest. The three distributed-CLI archives were independently inspected
after download. Local macOS arm64 upstream runtime smoke also passes; its
source-built CLI smoke is separate from released-ELF qualification.

[Run 41727012894](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41727012894)
passes the complete Linux preparation and both native macOS runtime jobs. Each
Mac job consumes the exact Ubuntu artifact ID `13275322365` from that same run,
verifies bundle hashes and all 145 files, and runs the stdio smoke with an empty
environment, private home and tested `sandbox-exec` network denial.

| Actual macOS system | Node | Runtime evidence SHA-256 |
| --- | --- | --- |
| `15.8.2`, `arm64` | `22.19.0`, `arm64` | `87945568774d38908d0d67d810f7de19715f0870eaacaffd990941297fcf78c5` |
| `15.7.9`, `x86_64` | `22.19.0`, `x64` | `a1aceaa4f49fa9229352372ef1b80a6d472ef04a18e214611e398a8b4e80d3e5` |

The earlier [run 41724182698](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41724182698)
remains failed: Linux and Intel succeeded, but GitHub cancelled the `macos-26`
ARM job without assigning a runner or executing a step, reporting hosted runner
capacity constraints. The succeeding run changes the ARM label to `macos-15`;
it preserves the same source lock and exact archive bytes. Earlier partial
proofs are retained separately and are not represented as a successful matrix.

These are held QA artifacts, not a public LSP release or catalog admission.
Manifest URLs name a planned release that does not yet exist. No submission
source commit or public package release is invented. Minimum macOS `12` and
packaged client installation remain unqualified.

## Existing application compatibility

Source inspection of application `v0.16.0`, commit
`7affa5ec15088db7c6dfe4f743f08fe981ac2b7d`, found that authenticated mixed-catalog
consumption filters well-formed unknown kinds. The frontend also skips unknown
entries while retaining the original signed envelope for mutations. This is
source inspection, not a historical packaged-application execution. It does not
change the production hold or establish managed LSP behavior in older clients.

## Retained public proofs

Key-free public receipts, exact signed catalogs, offline evidence and runtime
smokes are retained in the QA repository's
[campaign proof manifest](https://github.com/merkr-software/cadencr-registry-qa/blob/main/requests/stable-0155-lsp-20261103/proofs/manifest.json).
The manifest records each source run, byte size and SHA-256; original policy
failure artifacts are preserved separately in the adjacent `policy-recovery/`
directory. These files preserve evidence beyond Actions artifact retention and
do not serve as publication or recovery authority.

## Production boundary

- The monorepo template, offline qualification and official-plugin author pins
  select the same exact qualified CLI. The author qualification and policy hashes
  bind that selection; environment protection and per-publication review remain
  unchanged. This does not deploy the production registry or its author pins.
- The shared production catalog retains no LSP entries, and its LSP build feed
  remains unset. Production rollout belongs to the reviewed `v0.16.1` cutover.
- Native server distribution, actual managed install/update/remove/revocation
  in packaged clients, and remaining real-platform certification require their
  own evidence. CLI and inert-fixture success does not prove those behaviors.
