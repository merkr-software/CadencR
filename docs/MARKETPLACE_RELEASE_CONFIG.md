# Marketplace desktop build configuration

## Activation gate

The desktop release workflow forwards public repository variables into service
compilation. It does **not** provision trust, deploy feeds, generate signing keys,
or activate the public marketplace. Leaving every variable unset preserves
existing releases: catalog acquisition remains disabled. Empty workflow values
are removed before compilation, not embedded as empty `option_env!` pins.

`node scripts/validate-marketplace-build-env.mjs -- <build command>` validates and
forwards configured values. Invalid partial configuration stops the build before
Rust compilation. Runtime signature, freshness, compatibility, archive, and
blocklist checks remain authoritative; build validation does not replace them.

## Public repository variables

| Variable                                     | Configuration rule                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CADENCR_MANAGED_PROVIDER_KEY_ID`            | Host-owned signing key ID; starts with an ASCII alphanumeric character, followed by ASCII alphanumeric, `.`, `_`, or `-`; at most 128 bytes.                                                                                   |
| `CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64` | Canonical base64 representation of the host-owned 32-byte Ed25519 public key. Never a private key.                                                                                                                             |
| `CADENCR_MANAGED_PROVIDER_INDEX_URL`         | Credential-free HTTPS provider catalog URL. Existing schema-1 feeds remain supported; current clients may point at the signed mixed schema-2 feed.                                                                             |
| `CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL`     | Credential-free HTTPS signed policy URL, configured together with the provider catalog and both key variables.                                                                                                                 |
| `CADENCR_MANAGED_THEME_INDEX_URL`            | Additional activation pair with the theme blocklist, requiring the complete four-variable trust group. It must point at `https://raw.githubusercontent.com/<owner>/<repository>/refs/heads/marketplace-v2/managed-index.json`. |
| `CADENCR_MANAGED_THEME_BLOCKLIST_URL`        | Theme-only signed revocation policy at `https://raw.githubusercontent.com/<owner>/<repository>/refs/heads/marketplace-v2/managed-theme-blocklist.json`; same reviewed repository as the mixed catalog.                         |

The first four variables are all-or-none. The two theme feeds are also all-or-none.
Theme acquisition without a current verified revocation policy fails closed. Theme and provider acquisition use the
same pinned host-owned key; there is no independent theme signing-key input.
Current clients may set both catalog URL variables to the same mixed feed.
The isolated `marketplace-v2` branch must not overwrite the schema-1 discovery
branch still consumed by older releases.

No actual deployment URL or trust key is supplied here. Placeholders above are
syntax descriptions, not values to configure. Selecting a repository or enabling
these variables requires an explicit release-owner decision after deployment and
packaged-client verification.

## Release-owner prerequisites

Before activation, verify all of the following:

- [ ] A real registry repository, isolated mixed discovery branch, signed catalog,
      signed provider blocklist, signed theme revocation policy, and matching public trust root exist and are reviewed.
- [ ] The signing private key is confined to the protected publication environment,
      never desktop variables or application binaries.
- [ ] An accountable renewal owner, incident/revocation owner, monitored security
      contact, alert destination, and on-call escalation are assigned.
- [ ] Renewal scheduling, expiry monitoring, failure alerts, key compromise recovery,
      and replacement trust-root delivery have an exercised operational runbook.
- [ ] Clean packaged builds verify the mixed catalog, install/update/remove a theme,
      preserve user themes, and fail closed on tampering, unavailable policy, and
      revoked identity/version/checksum.

## Current operational gaps

Repository policy describes renewal and revocation requirements, but does not
establish a production owner, monitored security contact, alert destination,
signing environment, production key, or deployed feeds. This build wiring does
not close those operational gates and must not be represented as public activation.

## Theme revocation operator procedure

1. Review an inert policy with `schema_version: 1`, `kind: "theme-blocklist"`,
   canonical UTC whole-second `generated_at` / `expires_at`, and sorted unique
   `entries`. Each entry identifies `theme_id`, optional `version_requirement`,
   optional lowercase `archive_sha256`, and a bounded visible `reason`.
2. Sign and independently verify the reviewed payload with the released CLI:

   ```sh
   cadencr registry sign-theme-blocklist --payload reviewed-theme-policy.json \
     --private-key /protected/signing.pem --key-id reviewed-key-id \
     --output new-signed-theme-policy.json
   cadencr registry verify-theme-blocklist --index new-signed-theme-policy.json \
     --public-key reviewed-public.pem --key-id reviewed-key-id
   ```

3. A protected maintainer publishes the exact verified bytes to the reviewed
   theme policy feed. The CLI commands above sign/verify locally; they do not
   publish it, schedule renewal, assign ownership or authorize a remote write.
4. Verify the policy on a supported packaged client. Matching identity, version
   or digest prevents installation, preview, activation, update and duplication;
   confirmed removal remains available. Stale, missing, corrupt or replayed policy
   is not a reason to bypass verification.

Renewal and revocation change policy generations, not package bytes. Client caches
reject older generations and same-time conflicts. Never extend validity by
replacing timestamps without a new signature or reinterpret a provider blocklist
as a theme policy. An incident owner must decide whether an entire identity,
version range or specific digest is blocked; automation does not make that decision.
