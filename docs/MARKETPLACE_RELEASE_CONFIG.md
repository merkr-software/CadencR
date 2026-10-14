# Marketplace desktop build configuration

## After v0.13.0: populate the registry, no desktop activation

v0.13.0 is released with marketplace entry points hidden. The next milestone
publishes reviewed themes and Pi to the registry before a future activation
release. Keep official marketplace desktop build trust/feed variables unset;
publishing registry contents does not expose or configure the desktop UI.
The configuration below describes the later authorized desktop deployment.

Graphite, Ember and Fjord now pass isolated current-source UI/editor/terminal QA,
including persisted theme selection and author-project flags after service restart.
This is local-authoring evidence only: no public archive/install or packaged-client
acceptance is inferred. See the [current delivery checklist](./MARKETPLACE_V1.md)
for scoped evidence and the remaining publication gates.

Read-only CLI preparation CI and downloaded checksum verification are complete
([run 38214595106](https://github.com/merkr-software/CadencR/actions/runs/38214595106),
source `6d0e2b6ed39ceb22d9fd1fa785d5cb5fa8a09f93`). Its `v0.12.1`
artifact label belonged to preparation only. The actual
[v0.13.0 release](https://github.com/merkr-software/CadencR/releases/tag/v0.13.0)
now contains the Linux Rust CLI and checksums. Distributed-binary lifecycle
qualification, reviewed registry pins/cutover, JavaScript removal and plugin
publication remain pending; official desktop trust activation remains separate.

Internal QA can opt in with `VITE_INTERNAL_MARKETPLACE=true` in a DEV renderer
only; production builds cannot expose the marketplace through that environment
variable. This is not a public activation switch.

Use the [operator runbook](../tooling/marketplace-registry/OPERATIONS.md)
for renewal, failure alerts, revocation and rotation preparation. No real owner,
alert destination or production trust root is provisioned by this repository.

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

## Root-authorized trust generations

New builds may replace the legacy single-key group with the following public
configuration. The provider catalog/policy pair and theme catalog/policy pair
remain required for their respective acquisition paths. Legacy and generation
trust groups are mutually exclusive in release builds.

| Variable                                  | Meaning                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CADENCR_REGISTRY_TRUST_MANIFEST_JSON`    | Complete root-signed `registry-trust` envelope, bounded to 64 KiB. Never an unsigned key list. |
| `CADENCR_REGISTRY_ROOT_KEY_ID`            | Independently reviewed offline-root identity.                                                  |
| `CADENCR_REGISTRY_ROOT_PUBLIC_KEY_BASE64` | Canonical base64 32-byte offline-root Ed25519 public key; distinct from every metadata key.    |
| `CADENCR_REGISTRY_TRUST_MIN_GENERATION`   | Positive generation floor; defaults to `1`.                                                    |

Build preflight checks all-or-none public configuration, key encoding, manifest
shape and the minimum generation. The Rust service authenticates the complete
closed manifest against the offline-root signature before exposing registry trust.
Startup performs this check for both the desktop sidecar and MCP entry point,
then advances a private, signed generation floor beside application settings.
Invalid state is visible as a trust-configuration error; it is never deleted or
silently reset. An older single-key build using the new startup checks cannot
ignore an existing generation floor. This does not retrofit floor checks into
already released older applications.

### Rotation procedure

1. Provision the offline root independently from online publication keys. Keep
   its private key offline, outside the registry and ordinary publication jobs.
2. Review a manifest with `schema_version: 1`, `kind: "registry-trust"`, a strictly
   increasing `generation`, active delegated `keys` and `revoked_key_ids`.
   For ordinary A→B rotation, retain A with a fixed `retired_at` cutoff and add B
   as active. A can authenticate historical catalogs/policy baselines generated
   before that cutoff; A cannot authenticate a newly admitted catalog or policy.
3. Sign and verify locally with the Rust CLI:

   ```sh
   cadencr registry sign-trust-manifest --payload reviewed-trust.json \
     --root-private-key /offline/root.pem --root-key-id reviewed-offline-root \
     --output signed-trust.json
   cadencr registry verify-trust-manifest --manifest signed-trust.json \
     --root-public-key reviewed-root-public.pem --root-key-id reviewed-offline-root \
     --minimum-generation 2
   ```

4. Supply that reviewed profile to the publisher via the request's `trust` object
   (`manifest`, `root_public_key`, `root_key_id`, `minimum_generation`), with paths
   relative to the request. Inputs are captured immutably and content-bound for
   interruption recovery. Standalone catalog commands accept the all-or-none
   `--trust-manifest`, `--trust-root-public-key`, `--trust-root-key-id` flags and
   optional `--trust-minimum-generation`. Candidate public/private keys still
   identify the active metadata signer B; they are not the offline root.
5. Ship the reviewed envelope/root pins in a supported app build before switching
   feeds to B. Publish B-signed catalog and both policies. Verify A-cache→B-cache
   migration and installed historical receipts on that build. Retired-key policy
   baselines protect high-water continuity but do not make old policies usable
   as current revocation authority.

### Compromise recovery

Do not retain a compromised key as an ordinary active or historical authority.
Remove A, include A in `revoked_key_ids`, and authorize only independently
reviewed exact metadata checkpoints if necessary for cache/publication continuity:
`recovery_catalog_sha256`, `recovery_provider_policy_sha256` and
`recovery_theme_policy_sha256`. Each is a separate bounded list of lowercase
SHA-256 hashes of the complete canonical signed envelope, including its signature;
use the shared Rust canonical-JSON format, not raw-file hashes.

A checkpoint for one namespace cannot authenticate another. Checkpoints permit
baseline continuity only: they cannot authorize current metadata, execution or
installed theme/provider receipts. A B-signed successor still undergoes freshness,
immutability, rollback and equivocation checks. An unknown or altered historical
cache requires explicit recovery; deleting a cache or a database is not a recovery
procedure. Offline-root replacement/compromise is a distinct app-delivery incident,
not an ordinary delegated-key rotation.

## Theme policy freshness and offline behavior

- Cryptographic expiry remains an absolute validity boundary, not a polling TTL.
- First use after startup consults the configured policy feed. Subsequent ordinary
  polls occur at most 15 minutes apart when the app uses managed themes; concurrent
  refreshes coalesce. Failures retry after 60 seconds; forced refreshes have a
  five-second minimum interval to avoid request storms.
- With an authenticated, unexpired cached policy, existing revisions remain usable
  offline with a visible diagnostic. New remote preview/install/update fails with
  `MANAGED_THEME_POLICY_OFFLINE` until an online policy check succeeds.
- Missing, invalid, expired or revoked policy fails closed for theme usage;
  confirmed removal remains available. Feed renewal and incident ownership are
  still release-owner operational responsibilities.

## Deployment cutover still pending

These changes do not publish a CLI release, populate `PENDING` binary pins, switch
remote registry workflows, provision official roots/feeds or certify a packaged
client. Verify the real distributed Rust binary first, then pin both registry
workflows and commands, then remove replaced JavaScript implementations. The
transitional JavaScript validator is not a supported substitute for schema-2 mixed
contributions or the trust-generation publication protocol.
