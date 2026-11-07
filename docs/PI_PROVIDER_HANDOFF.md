# Pi retirement and provider ownership handoff

The first-party Pi connector is retired in favor of
[edjubert's independent connector](https://github.com/edjubert/cadencr-plugin-provider-pi).
The [namespace authorization](https://github.com/merkr-software/cadencr-registry/pull/22#issuecomment-6630319571)
assigns `pi` / **Pi** to publisher `edjubert` and that repository. Admission of a
replacement package remains a separate maintainer decision.

## Signed contract

Provider handoffs are append-only signed records binding every retired version
and its canonical entry digest to the original owner/source and authorized
successor. Accepted packages, assets and authenticated catalog entries remain
immutable. Compatible clients hide retired listings and reject new installations
of retired versions while retaining the complete signed envelope.

Ordinary contributions cannot introduce handoffs or mutate history. Explicit
administrative validation checks the operator record; it does not authorize
publication. Signatures, trust, authenticated-baseline continuity and protected
publication remain mandatory.

## Client compatibility

| Consumer | Catalog | Policies |
| --- | --- | --- |
| Existing clients | `marketplace-v2` | Existing legacy URLs |
| Handoff-compatible clients | `marketplace-v2-admin` | Existing legacy URLs |

Older clients reject the signed handoff field. Never publish it on the legacy
channel. Compatible clients use an independent administrative cache/high-water
mark, with no fallback that restores a retired listing or relaxes verification.

Before delivering compatible clients, seed the administrative branch from the
exact authenticated legacy head. Retain both histories; do not replace the
baseline with an empty bootstrap. Qualify the released CLI and compatible clients,
then separately review and publish the retirement-only signed request. Merging
source code does not update the live catalog.

## Installed providers and sessions

Updates reject a different owner before download/probing; rollbacks enforce
ownership before conformance. Both are checked again at activation. Existing
installations keep their immutable owner receipts.
Switching connectors requires explicit removal and a separately admitted install.

Sessions using a matching successor receipt require publisher/source-bound IDs.
The successor rejects raw or foreign-owner IDs during init, prompt and compact.
Historical receipts and non-transferred providers retain their native IDs. Keep
existing conversations and native session files; do not assume compatibility
between the two Pi implementations.
No database migration or blanket `pi` revocation is part of retirement.

The [registry operations guide](https://github.com/merkr-software/cadencr-registry/blob/main/OPERATIONS.md)
owns publication, channel renewal and public verification procedures.
