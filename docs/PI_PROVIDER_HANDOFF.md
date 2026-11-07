# Pi retirement and namespace handoff

## Authority and source retirement

The decision recorded on 2026-11-04 retires first-party Pi in favor of
[edjubert's connector](https://github.com/edjubert/cadencr-plugin-provider-pi):
provider ID `pi`, display name **Pi**, publisher `edjubert`, and its own repository.
The [maintainer authorization](https://github.com/merkr-software/cadencr-registry/pull/22#issuecomment-6630319571)
assigns the namespace; replacement artifact admission remains separate.

Source retirement is already integrated on main in
`48ff864876015bff24be1d991bd96b5b39ccbd20`, through merge `73c4a553d`.
It removes `plugins/providers/pi`, package scripts and lockfile importer,
the native qualification workflow and official release allowlist entry.
Remaining checks cover Cursor and themes. Historical QA, tags and assets remain.
The parallel signed retirement `acf5edbf8167824b44e1bfef5a675731911397be`
remains in the Pi history; forward reconciliation does not repeat the removal.
The original checkout at `229d9c59f` and its unrelated database are preserved.
Existing installations, receipts, conversations and session IDs are not rewritten.

## Forward reconciliation boundary

The local Pi chain ends at `53aa303cc77246c25aa595ad567e1d7e07b54aac`.
The current main input is `da81a83a594554d89e00565fb93ce079f5a7c552`, including
final PR #385 WebSocket corrections, telemetry fixes and compact-flow spacing.
The common ancestor is `ebd19991470b15aff76ea61bfed0f39e8318bb60`.

Both histories are preserved. The only automatic merge conflict is this document,
combining historical retirement evidence and the newer shared contract. Current
main's release-policy bytes and all 25 LSP records are retained. All three final
proxy files, including `proxy/outbound.rs`, retain current-main bytes. The initial
WS fix is not substituted for the final reviewed corrections.

This preparation creates no commit or future main SHA. A two-parent merge needs
explicit local commit approval, normal hooks and signing. Source integration and
release retain their separate developer gates.

## Signed contract and session safety

The Pi branch implements administrative transfer in registry-core, publisher and
CLI, verified service projection, desktop filtering and publisher/source session
binding. Accepted packages, signed envelopes, receipts, assets, installations and
conversations are retained. No database migration or blanket `pi` revocation occurs.

- Handoffs are append-only and bind every retired version to its original owner
  and canonical mirrored-entry digest. Ordinary immutability, signatures, trust,
  baseline continuity and protected publication remain mandatory.
- Old clients use `marketplace-v2`; compatible clients use `marketplace-v2-admin`
  with a separate monotonic cache. Existing policy URLs/domains stay on legacy.
  A newer legacy renewal cannot restore retired listings in the compatible channel.
- Seed the new branch from the exact authenticated legacy head before delivering
  clients using it. The copied baseline is compatible while retirement awaits
  protected signing. Empty bootstrap and continuity bypasses are forbidden.
- Cross-owner installed updates fail before downloads/probes and again at
  activation. Existing installations retain their original immutable receipts.
- Successor session IDs are bound to publisher/source from their first runtime
  event, including terminal resume. Raw or foreign-owner IDs fail visibly while
  their messages/native files remain. First-party session compatibility is not
  assumed; switching implementations requires a separately admitted installation.

Deleting accepted JSON files cannot delist a signed catalog. An isolated deletion
attempt failed with `deletion is not allowed` for all four Pi files. Contribution,
catalog and signed-snapshot checks remain active; explicit retirement changes the
active projection while retaining authenticated historical entries.

## Historical candidate evidence: 2026-11-04

These earlier observations remain historical evidence, not current admission.
Published `pidancr` assets remain immutable.

| Item | Historical observation |
| --- | --- |
| Registry PR #22 | Head `a1f2aa6684ba4be0ccb7bdb962b2a385b2ee84d7`, `pidancr 0.2.0` files despite `0.2.1` title/body |
| Existing checks | `inert-metadata` and `contributor-tooling` passed for that old head |
| Release examined | Immutable `v0.2.1`, source `5a28d3feda63ac8ed327d3696a7f48e21f5639d3` |
| Author CI | Run `41814529310` succeeded for that source |
| Public assets | Eight downloaded; SHA-256 values matched GitHub asset digests |
| Metadata | Package matched submission; all four archive hashes matched |
| Static inspection | Four targets; no absolute/traversal paths, duplicates, links, special files or setuid/setgid bits |
| Inert validation | Released package/submission passed CLI metadata validation |
| Native evidence | Author reported macOS arm64/Intel and Linux arm64/x86-64, Pi `1.5.0`; not independently repeated |

No contributor executable ran. The rename request asked for `pi` / Pi and a new
immutable version above retired `0.4.1`, updating descriptor, metadata, archive
names, documentation and native evidence together.

The later Pi `0.5.0` candidate at source
`f10dd1298eb081e50505d33bc6674e21bd4f0dd2` has separate inert provenance/audit
evidence. Admission and native execution remain held; detailed security review
stays private. Author execution needs exact authorization. Replacement admission
is not a prerequisite for retiring our first-party versions.

## Delivery and evidence boundaries

[Registry issue #23](https://github.com/merkr-software/cadencr-registry/issues/23)
tracks effective retirement. Its exact request/order are prepared in local
registry review commit `96bc3706c82a9199bfc2afe2082f9002c8e626ba`, file
`administration/PI_PROVIDER_HANDOFF.md`; that preparation is not deployed.

CLI `0.15.6` was released/qualified for LSP. Approved local Pi preparation sets
`0.15.7`; this is not a qualified distributed release. Only the actual published
binary and its qualification supply the atomic version/tag/digest pin. No future
digest or integrated SHA is inferred. Application version/release and production
activation remain separate decisions.

Retained Pi tests and five-case development UI QA cover Pi code before this
combination. Final WS corrections have macOS/Ubuntu automated network evidence;
live gen4 QA covered the earlier fix. Neither set alone qualifies the combined
service or a packaged app. Byte comparisons and focused checks identify reusable
evidence. Normal merge hooks, required combined-service/Linux checks and packaged
macOS/Linux installed-session behavior remain explicit gates.

- [x] Retire first-party source and publication allowlist on main.
- [x] Record namespace authority and retain historical candidate evidence.
- [x] Prepare local signed-retirement tooling and compatible client behavior.
- [ ] Integrate and validate the exact forward combination under its own gate.
- [ ] Release/qualify the distributed CLI and promote its real atomic pin.
- [ ] Seed the authenticated channel and deliver qualified compatible clients.
- [ ] Publish retirement-only signed catalog and verify public/client behavior.
- [ ] Separately review exact successor admission.
