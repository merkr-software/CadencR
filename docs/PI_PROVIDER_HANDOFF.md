# Pi retirement and namespace handoff

## Source and contract

The owner authorized retiring the first-party Pi implementation in favor of the
independent `pi` namespace owned by `edjubert` at
https://github.com/edjubert/cadencr-plugin-provider-pi. The
[authorization](https://github.com/merkr-software/cadencr-registry/pull/22#issuecomment-6630319571)
is namespace authority, not acceptance of a replacement executable.

This integration applies source retirement `229d9c59f` onto current release
architecture: removes `plugins/providers/pi`, its commands/importer, native
qualification workflow and official release allowlist. It also implements the
explicit signed administrative transfer contract in registry-core/publisher/CLI,
verified service projection, desktop filtering and publisher/source session binding.
Historical accepted packages, signed envelopes, receipts, assets, installations,
conversations and databases are retained. No data migration or blanket `pi`
revocation is introduced.

## Compatibility and session safety

- Handoff records are append-only, bind every old version to its exact owner and
  canonical mirrored-entry digest, and constrain future versions to the successor.
  Normal contribution immutability, signature trust, baseline continuity and
  protected publication remain mandatory.
- Old clients stay on `marketplace-v2`; compatible clients use the fixed
  `marketplace-v2-admin` channel and a separate monotonic catalog cache. Existing
  policy URLs/domains remain on the legacy feed. A newer legacy renewal cannot
  cause fallback to a retired listing in the compatible channel.
- Seed the new branch from the exact authenticated legacy head before shipping
  clients pointing to it. Its copied baseline is compatible while retirement
  waits for protected signing. Do not use empty bootstrap or disable continuity.
- An installed provider cannot update across publisher/repository ownership.
  The guard runs before archive download/contributor probes and again at activation.
  Existing installed state remains usable under its original immutable receipt.
- Newly saved transferred-provider sessions are host-bound to publisher/source,
  persisted from the first runtime event and decoded only for the matching owner.
  Old raw/foreign-owner sessions fail visibly; their messages/native files remain.
  Terminal resume enforces the same binding. No compatibility between first-party
  Pi sessions and the independent connector is assumed.

## Delivery state

Implementation and local checks do not constitute live retirement. The exact
registry operation, candidate evidence, delivery order and release/publication
approvals are in
[`administration/PI_PROVIDER_HANDOFF.md`](https://github.com/merkr-software/cadencr-registry/blob/main/administration/PI_PROVIDER_HANDOFF.md)
on the corresponding registry review branch until merged.

CLI `0.15.6` was already released/qualified for LSP. This change requires a new
reviewed CLI release (proposed `0.15.7`) and a real atomic version/tag/digest pin
only after release qualification. Coordinate the compatible desktop release with
the proposed application `0.16.1` preparation. Preserve those independent release controls.
The canonical integration is based on `ebd19991470b15aff76ea61bfed0f39e8318bb60`,
preserving PR #381 and all 25 LSP policy entries unchanged. The earlier development
checkout based on `d2b4023a02e4238214ad6563d8fc02ac0bed3330` is retained as evidence.

The retirement request contains no new publications. The independent immutable
Pi `0.5.0` candidate at source `f10dd1298eb081e50505d33bc6674e21bd4f0dd2`
remains pending separate provenance/security acceptance and native qualification.
Detailed review is retained privately under the registry security policy. Its
native execution is suspended pending exact authorization.
It is not a prerequisite for our retirement publication.
