# Registry trust generations use an independent offline root

Registry metadata keys are delegated by a domain-separated manifest authenticated
by an independently pinned offline root. The desktop receives reviewed generations
with an app build, while protected publishing receives the same verified profile;
replacing a metadata key alone cannot authenticate its predecessor or safely
recover from compromise.

## Consequences

- Retired keys authenticate only historical snapshots generated before their
  fixed retirement cutoff; current catalog and policy admission requires active keys.
- Compromised keys are removed and explicitly revoked. Exact, separately scoped
  root-endorsed catalog/provider-policy/theme-policy checkpoints permit continuity
  recovery but never current admission or installed-content authorization.
- A private, durable generation floor rejects rollback, same-generation
  equivocation, key-ID reuse and revoked-key resurrection. Caches retain original
  signed envelopes rather than an unsigned provider projection.
- App delivery is the trust transition mechanism in v1. Metadata downloads cannot
  supply their own root. Offline-root compromise requires a separately reviewed app
  recovery, not ordinary metadata rotation.

## Considered options

Keeping the old key as a normal authority makes compromise recovery unsafe.
Accepting a successor simply because its signature is valid under a replacement
key loses authenticated continuity. Remote automatic root updates add another
security protocol and are deferred; this v1 trades immediate rotation for an
explicit app rollout and a root-authenticated transition.
