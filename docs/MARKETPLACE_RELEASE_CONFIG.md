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
contains the original Linux Rust CLI and checksums. The latest CLI-only delivery,
`0.13.1-dev.39144478778.1`, includes the remaining standalone Rust diagnostics.
See its [dated qualification record](./MARKETPLACE_RUST_CUTOVER_QUALIFICATION_2026-10-18.md)
for exact provider/theme/tab runs and failure history. These use inert fixtures
and QA-only trust, not production credentials or runtime certification.
JavaScript business implementations and executable legacy test oracles are
removed from the source template; thin orchestration and frozen test data remain.
The candidate registry pin still targets an older CLI. Reviewing its replacement,
regenerating delivery approvals, actual registry deployment and official-plugin
publication remain pending.

The marketplace UI is visible in every desktop build; there is no renderer
opt-in. Whether it can browse or install anything depends only on the feed and
trust configuration compiled into the service. A build without that
configuration (dev builds, forks) shows the marketplace as unavailable: the
catalog page says it is not available in this build and offers no retry, and
anything already installed stays manageable.

Use the [operator runbook](../tooling/marketplace-registry/OPERATIONS.md)
for renewal, failure alerts, revocation and rotation preparation. No real owner,
alert destination or production trust root is provisioned by this repository.
The registry template also carries an automatic, renewal-only workflow for the
catalog and the three revocation policies (daily, renewing when due) and a read-only
expiry watch (daily); see
[Automatic catalog and policy renewal and expiry watch](../tooling/marketplace-registry/OPERATIONS.md#automatic-catalog-and-policy-renewal-and-expiry-watch).
They are template files, not deployed, and inert until configured as described below.

## Activation gate

**State 2026-10-28:** activated for the v0.16.0 release, on the release
owner's go. The UI gate is removed on the release branch, the variables below
are set on `merkr-software/CadencR`, and both desktop release workflows run
`node scripts/validate-marketplace-build-env.mjs --require-catalog`, so a
release without the root-authorized trust and the catalog feeds fails before
compiling the service. Until that branch is merged, `main` still hides the
marketplace (`VITE_INTERNAL_MARKETPLACE` gate); a release from `main` in the
meantime compiles the feeds into the service but shows no marketplace.

### Activation runbook

Everything below is public data; no secret is involved. Do it only on the
release owner's explicit go, right before the activation release.

1. **Show the marketplace in every build.** Done for v0.16.0 by re-applying
   `89b2b9f11` (gate removed, honest "not available in this build" state) and
   the `catalogSourceMissing` helper reuse from `9e4c5ea93`, which
   `82c0b4263` had hidden again on `main`. The original commits also live on
   the branch `feature/marketplace-activation`.

2. **Compile the production trust and feeds into releases.** From the
   repository root:

   ```sh
   R=merkr-software/CadencR
   B=https://raw.githubusercontent.com/merkr-software/cadencr-registry/refs/heads/marketplace-v2
   jq -c . docs/marketplace-trust/signed-trust-gen1.json | gh variable set CADENCR_REGISTRY_TRUST_MANIFEST_JSON -R $R
   gh variable set CADENCR_REGISTRY_ROOT_KEY_ID -R $R -b cadencr-root-1
   gh variable set CADENCR_REGISTRY_ROOT_PUBLIC_KEY_BASE64 -R $R -b 'qUXWCxcpNirGB4FE6xSo9azWv3RR2Fu+szGlS39074Q='
   gh variable set CADENCR_REGISTRY_TRUST_MIN_GENERATION -R $R -b 1
   gh variable set CADENCR_MANAGED_PROVIDER_INDEX_URL -R $R -b "$B/managed-index.json"
   gh variable set CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL -R $R -b "$B/managed-blocklist.json"
   gh variable set CADENCR_MANAGED_THEME_INDEX_URL -R $R -b "$B/managed-index.json"
   gh variable set CADENCR_MANAGED_THEME_BLOCKLIST_URL -R $R -b "$B/managed-theme-blocklist.json"
   gh variable set CADENCR_MANAGED_TAB_BLOCKLIST_URL -R $R -b "$B/managed-tab-blocklist.json"
   ```

   Check them with the same validator the release workflows run:

   ```sh
   eval "$(gh variable list -R $R --json name,value --jq '.[] | select(.name|test("^CADENCR_(MANAGED|REGISTRY)_")) | "export \(.name)=\(.value|@sh)"')"
   node scripts/validate-marketplace-build-env.mjs
   ```

3. **Before the release, check the registry is healthy:** the latest
   `watch-registry-expiry` run on `merkr-software/cadencr-registry` is green and
   the catalog has more than 72 hours of validity left.

4. **Release and verify the artifact before publishing.** Open the release DMG
   on a machine where no other Cadencr runs (the packaged service always binds
   `127.0.0.1:5004`): the Marketplace entry is in the sidebar, Discover lists
   the signed catalog, a theme installs and applies.

For a local packaged check, export the same variables and run
`node scripts/validate-marketplace-build-env.mjs -- pnpm build:local`; turbo
passes `CADENCR_MANAGED_*` and `CADENCR_REGISTRY_*` through.

To deactivate again, restore the gate (`82c0b4263`), drop `--require-catalog`
from the release workflows and delete the nine variables.

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

| Variable                                     | Configuration rule                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CADENCR_MANAGED_PROVIDER_KEY_ID`            | Host-owned signing key ID; starts with an ASCII alphanumeric character, followed by ASCII alphanumeric, `.`, `_`, or `-`; at most 128 bytes.                                                                                                           |
| `CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64` | Canonical base64 representation of the host-owned 32-byte Ed25519 public key. Never a private key.                                                                                                                                                     |
| `CADENCR_MANAGED_PROVIDER_INDEX_URL`         | Credential-free HTTPS provider catalog URL. Existing schema-1 feeds remain supported; current clients may point at the signed mixed schema-2 feed.                                                                                                     |
| `CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL`     | Credential-free HTTPS signed policy URL, configured together with the provider catalog and both key variables.                                                                                                                                         |
| `CADENCR_MANAGED_THEME_INDEX_URL`            | Additional activation pair with the theme blocklist, requiring the complete four-variable trust group. It must point at `https://raw.githubusercontent.com/<owner>/<repository>/refs/heads/marketplace-v2/managed-index.json`.                         |
| `CADENCR_MANAGED_THEME_BLOCKLIST_URL`        | Theme-only signed revocation policy at `https://raw.githubusercontent.com/<owner>/<repository>/refs/heads/marketplace-v2/managed-theme-blocklist.json`; same reviewed repository as the mixed catalog.                                                 |
| `CADENCR_MANAGED_TAB_BLOCKLIST_URL`          | Custom-tab-only signed revocation policy (`kind: "tab-blocklist"`), e.g. `https://raw.githubusercontent.com/<owner>/<repository>/refs/heads/marketplace-v2/managed-tab-blocklist.json`; same signing key and reviewed repository as the mixed catalog. |

The first four variables are all-or-none. The two theme feeds are also all-or-none.
The tab policy URL goes with the theme feeds: the desktop release workflow forwards it, and
`validate-marketplace-build-env.mjs` requires it whenever the theme feeds are set, in the same
reviewed repository. A build without it blocks nothing and refuses nothing
(see [Custom tab revocation](#custom-tab-revocation)).
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
      and replacement trust-root delivery have an exercised operational runbook
      (the registry template's daily renewal and daily watch are configured, the
      renewal environment is protected, and a failing watch run reached a human).
- [ ] Clean packaged builds verify the mixed catalog, install/update/remove a theme,
      preserve user themes, and fail closed on tampering, unavailable policy, and
      revoked identity/version/checksum.

## Registry repository variables for renewal and expiry watch

These belong to the **registry repository** (not the desktop release workflow, and
never compiled into the app). Leave them all unset until activation is authorized:
the renewal and watch workflows then skip with a notice. Once
`CADENCR_REGISTRY_CATALOG_URL` is set the jobs treat any missing or invalid input as
an error.

| Variable                                                                                                                                                | Meaning                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `CADENCR_REGISTRY_CATALOG_URL`                                                                                                                          | Stable catalog feed; the activation switch. Same URL the desktop `CADENCR_MANAGED_*_INDEX_URL` pins.    |
| `CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL`, `CADENCR_REGISTRY_THEME_BLOCKLIST_URL`, `CADENCR_REGISTRY_TAB_BLOCKLIST_URL`                                 | The three signed revocation policy feeds the watch checks (mirrors the desktop `*_BLOCKLIST_URL` pins). |
| `CADENCR_REGISTRY_KEY_ID`, `CADENCR_REGISTRY_PUBLIC_KEY_PEM`                                                                                            | Public signing identity (PEM, not the base64 form used by desktop builds); no private material.         |
| `CADENCR_REGISTRY_TRUST_MANIFEST_JSON`, `CADENCR_REGISTRY_ROOT_KEY_ID`, `CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM`, `CADENCR_REGISTRY_TRUST_MIN_GENERATION` | Optional root trust profile (the request's `trust` object); the first three are all-or-none.            |

The signing key and publication token are secrets of the protected
`protected-marketplace-renewal` environment (distinct from the reviewed
`protected-marketplace-publisher` environment). The catalog and the three
revocation policies (provider, theme, custom tab) are renewed automatically while
their entries are unchanged. The first publication of the three policies (empty) is
the dispatched, reviewed `bootstrap-revocation-policies` workflow in the
`protected-marketplace-publisher` environment, which holds the only copy of the
signing key; changing a policy's entries remains a reviewed, manual procedure. The
policy URLs are not needed for the bootstrap, but all three are required by the
renewal as well as the watch.

## Current operational gaps

Repository policy describes renewal and revocation requirements, but does not
establish a production owner, monitored security contact, alert destination,
signing environment, production key, or deployed feeds. The renewal and watch
workflows are templates: nothing is scheduled or deployed from this repository.
This build wiring does not close those operational gates and must not be
represented as public activation.

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
   theme policy feed with `cadencr registry publish-policy --kind theme` (see
   [Policy publication and renewal](#policy-publication-and-renewal)). The
   sign/verify commands above work locally and publish nothing.
4. Verify the policy on a supported packaged client. Matching identity, version
   or digest prevents installation, preview, activation, update and duplication;
   confirmed removal remains available. Stale, missing, corrupt or replayed policy
   is not a reason to bypass verification.

Renewal and revocation change policy generations, not package bytes. Client caches
reject older generations and same-time conflicts. Never extend validity by
replacing timestamps without a new signature or reinterpret a provider blocklist
as a theme policy. An incident owner must decide whether an entire identity,
version range or specific digest is blocked; automation does not make that decision.

## Policy publication and renewal

The provider, theme and custom tab policies share one command family. The provider
policy is the closed document `{schema_version, generated_at, expires_at, entries}`
(no `kind`; entries `provider_id`, optional `version_requirement`, optional lowercase
`archive_sha256`, `reason`, sorted and unique, no explicit `null`), signed with the same key:

```sh
cadencr registry sign-provider-blocklist --payload reviewed-provider-policy.json \
  --private-key /protected/signing.pem --key-id reviewed-key-id \
  --output new-signed-provider-policy.json
cadencr registry verify-provider-blocklist --index new-signed-provider-policy.json \
  --public-key reviewed-public.pem --key-id reviewed-key-id
```

Each policy lives at one fixed path on the discovery branch: provider
`managed-blocklist.json`, theme `managed-theme-blocklist.json`, tab
`managed-tab-blocklist.json` (the `*_BLOCKLIST_URL` pins above point at them).

**Renew** (the routine, automated case): same entries, strictly newer generation, later
expiry inside the 14-day maximum. The current policy must authenticate with the pinned
public key; an expired one is accepted if it is correctly signed. The result is verified
again before it is written, and the command refuses a kind that does not match the
document, a signing key other than the pinned one, and an existing output file.

```sh
cadencr registry renew-policy --kind provider|theme|tab --current current-signed.json \
  --public-key reviewed-public.pem --key-id reviewed-key-id \
  --private-key /protected/signing.pem --expires-at 2026-11-08T00:00:00Z \
  --output renewed-signed.json
```

**Publish** (token in `CADENCR_REGISTRY_GITHUB_TOKEN`, never on the command line):

```sh
cadencr registry publish-policy --kind provider|theme|tab --signed renewed-signed.json \
  --repository <owner>/<repository> --discovery-branch marketplace-v2 \
  --public-key reviewed-public.pem --key-id reviewed-key-id [--bootstrap | --renewal] [--receipt receipt.json]
```

The candidate must be current and authenticate; the policy already on the branch must
authenticate (expired is fine) and be strictly older, otherwise the command refuses
(no rollback, no same-time replacement). With no file on the branch, `--bootstrap` is
required, and `--bootstrap` is refused when the file exists (with the online key held
only as an environment secret, use the `bootstrap-revocation-policies` workflow for
the first publication). The update is one
conditional write of that single path (a concurrent change makes it fail, never
overwrite), a lost response is reconciled by reading the branch back, and the public
raw URL is then read without credentials until it serves exactly the candidate. That
read tolerates the exact previous body for up to six minutes (360 s), because
raw.githubusercontent.com caches for up to 300 s; any other body fails at once and an
exhausted budget fails closed. The authenticated read-back keeps its 30 s window.
`--receipt` writes a small JSON record of the verified result.

`--renewal` is what the unattended workflow passes: the published policy must carry
exactly the candidate's entries (only the window may differ), otherwise the command
refuses, so a renewal built from a stale baseline cannot drop a revocation published
since. `cadencr registry fetch-policy` reads the branch head through the authenticated
API (not the CDN) for the baseline. The provider policy must fit the 1 MiB the desktop
service downloads in total, so its signed payload is capped slightly below that.

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

## Key custody runbook

`scripts/marketplace-keys.sh` is the operator tool for the two-level trust model on
the release owner's Mac. The Keychain commands (`generate-root`, `sign-trust`,
`verify-backup`) refuse to run off macOS (`CADENCR_KEYS_ALLOW_NON_DARWIN=1` exists for
tests only); `generate-online` needs only `gh` and OpenSSL and also runs on Linux. Every
command accepts `--dry-run` to print the plan, and
reads its tools from `CADENCR_BIN`, `OP_BIN`, `SECURITY_BIN`, `GH_BIN` and
`OPENSSL_BIN`. Ed25519 needs OpenSSL 3 (`brew install openssl@3`); the LibreSSL that
ships with macOS cannot generate it.

| Key                                             | Lives in                                                                                                                 | Never in                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Offline root (signs trust generations)          | The owner's login Keychain (service `cadencr-marketplace-root`, account = root key id) **and** one 1Password Secure Note | Any GitHub secret, repository, CI runner or build variable |
| Online signing key (signs catalog and policies) | GitHub environment secret `CADENCR_REGISTRY_PRIVATE_KEY_PEM` in the publication and renewal environments only            | The Mac, 1Password, the repository                         |

The two root-key stores hold the same value: the single-line base64 of the PKCS8 PEM.
The online key is uploaded to GitHub as the raw PEM. A private key never appears on
argv, stdout or stderr. Keychain writes go through
`security -i` and 1Password writes through an item template, both on stdin; GitHub
secrets are streamed from the key file to `gh secret set` on stdin. The CLI refuses
FIFOs and symlinks as key files, so `sign-trust` uses a `0600` file inside a `0700`
`mktemp` directory. The key file is overwritten with random bytes and removed right
after signing, and anything left in the directory gets the same treatment on every exit
path including INT, TERM and HUP. The overwrite is best effort only: it is not
guaranteed on APFS (copy-on-write, snapshots) or SSDs (wear levelling). FileVault is the
real at-rest protection, together with the 0700 directory and the short lifetime.
Public outputs (`--public-pem-out`, the verified trust manifest) are written `0644`;
an existing `--public-pem-out` file is refused before any key is generated or stored.
`--item-title`, `CADENCR_KEYS_SERVICE`, key ids and `--keychain` are validated against
a safe character set because they are interpolated into the `security -i` input and
the 1Password item template.

### Generate the keys

```sh
scripts/marketplace-keys.sh generate-root --key-id <root-key-id> --vault <vault> \
  --public-pem-out ./root-public.pem
scripts/marketplace-keys.sh generate-online --key-id <online-key-id> \
  --repo <owner>/<registry-repo> --env <publication-env> --env <renewal-env>
```

Both print only the key id and public key (base64 of the raw 32 bytes, the form the
`CADENCR_REGISTRY_ROOT_PUBLIC_KEY_BASE64` and trust manifest `public_key_base64`
fields use, plus the SPKI PEM the CLI verifiers take). `generate-root` refuses to
overwrite an existing Keychain or 1Password entry, writes 1Password first, reads both
copies back and requires them to be identical; if a step fails it names the store to
inspect and never deletes anything (if the Keychain write fails after the 1Password
item was created, remove that item by hand before re-running). Review the printed public keys independently
before pinning them in a build.

### Sign generation 1

Write the payload (`schema_version: 1`, `kind: "registry-trust"`, `generation: 1`, one
active `keys` entry holding the online public key, empty `revoked_key_ids`), review
it, then:

```sh
scripts/marketplace-keys.sh sign-trust --payload reviewed-trust.json \
  --output signed-trust.json --key-id <root-key-id> \
  --root-public-key ./root-public.pem --minimum-generation 1
```

The tool runs `cadencr registry sign-trust-manifest`, verifies the result with
`verify-trust-manifest` against the root public key and the generation floor, and
only then writes the output (it will not overwrite one without `--force`). Ship the
verified envelope and root pins in a build per the rotation procedure above.

### Online key rotation (root stays offline)

1. `generate-online` with a new `--key-id`; it uploads the new private key to the
   named environments (use `--secret-name` for a staged secret) and prints its public key.
2. Author generation N+1: retain the old online key with a `retired_at` cutoff, add
   the new one as active, and `sign-trust` with `--minimum-generation N+1`.
3. Ship the new envelope in a supported build, then switch the environment secret to
   the new key and publish. Never reuse a key id.

Renewal of catalog and policy freshness is performed by the online key in the renewal
environment and needs neither the root nor the Mac.

### Verify the backups

```sh
scripts/marketplace-keys.sh verify-backup --key-id <root-key-id> --vault <vault> \
  --expected-public-key ./root-public.pem
```

Reads both copies without printing them, requires them to be byte-identical and the
derived public key to match the reviewed one. Run it after generation and on a
schedule the release owner owns.

### Mac lost or Keychain wiped

The root is recoverable from 1Password; nothing else on the lost Mac is required.
On a replacement Mac, with the 1Password CLI signed in, read the Secure Note
(`op item get cadencr-marketplace-root-<root-key-id> --vault <vault> --fields
notesPlain`) straight into the new login Keychain with `security -i` (the secret
must stay off argv), then run `verify-backup`. If 1Password is also gone, or the root
is suspected compromised, this is the app-delivery incident described under
"Compromise recovery": a new root requires a new build that pins it, not a rotation.
A stolen or lost laptop with an unlocked Keychain is a suspected compromise.

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
  confirmed removal remains available. Renewal of an unchanged policy is automated
  by the registry's renewal workflow (about every five days, with 13-day windows);
  incident ownership and entry changes remain release-owner responsibilities.

## Custom tab revocation

Custom tabs have their own signed feed, separate from the theme and provider
policies and signed with the same host-owned key. The service compiles its URL in
with `option_env!("CADENCR_MANAGED_TAB_BLOCKLIST_URL")` (empty values count as unset);
there is no runtime override. Tests configure a fixture feed per storage root.
`scripts/validate-marketplace-build-env.mjs` refuses a release build that sets the
mixed catalog without this feed (or the reverse), and requires the
`marketplace-v2/managed-tab-blocklist.json` path in the catalog's repository;
`desktop-release.yml` forwards it from the repository variable of the same name.

**Custom builds have no such guard.** Only that release validator ties the two
together; the service itself treats an unset tab feed as "no policy source". A
build compiled with the mixed catalog URL but without
`CADENCR_MANAGED_TAB_BLOCKLIST_URL` (a fork, a local `cargo build` with only the
catalog variables) therefore lists, installs, updates and starts marketplace tabs
with **no tab revocation at all**: nothing is ever blocked, and nothing is refused
for want of a fresh policy. This is the same accepted gap as the other feeds'
build-time pairing, not a runtime fail-closed rule; anyone shipping such a build
to users owns the consequence, and should set both variables (or neither).

Payload (`schema_version: 1`, `kind: "tab-blocklist"`, canonical UTC whole-second
`generated_at` / `expires_at`, window at most 14 days, entries sorted and unique):

```json
{
  "schema_version": 1,
  "kind": "tab-blocklist",
  "generated_at": "…",
  "expires_at": "…",
  "entries": [
    {
      "tab_id": "port-monitor",
      "version_requirement": "<1.3.0",
      "archive_sha256": "<web archive>",
      "executable_sha256": "<backend binary>",
      "reason": "…"
    }
  ]
}
```

An entry matches when every field it sets matches: `tab_id` alone blocks every
version; `version_requirement` is a semver range; `archive_sha256` names one signed web
archive (`tab.distribution.sha256`); `executable_sha256` names one backend binary
(`tab.distribution.binary.<platform>.executable_sha256`) and never matches a tab
without a backend. Sign and verify with the released CLI:

```sh
cadencr registry sign-tab-blocklist --payload reviewed-tab-policy.json \
  --private-key /protected/signing.pem --key-id reviewed-key-id \
  --output new-signed-tab-policy.json
cadencr registry verify-tab-blocklist --index new-signed-tab-policy.json \
  --public-key reviewed-public.pem --key-id reviewed-key-id
```

Client behavior:

- The service polls the feed at startup and every 10 minutes; concurrent refreshes
  coalesce, forced refreshes wait at least 5 seconds, failures retry after 60 seconds.
  The download uses the catalog client (HTTPS only, bounded size).
- The verified envelope is cached at `<plugins>/managed-tabs/.tab-blocklist.json`.
  The cache is a high-water mark: an older `generated_at`, or a different payload with the
  same `generated_at`, is rejected. A corrupt or symlinked cache is never replaced.
- Any authenticated cached policy blocks what it lists, even after it expires or after
  its key is retired. Blocked tabs can still be removed.
- Only a fresh policy (active signer, unexpired) lets a managed tab install, update or
  start its native backend while the feed is configured. Otherwise those fail with
  `MANAGED_TAB_POLICY_UNAVAILABLE`; the tab's web UI keeps working.
- Key rotation and compromise recovery work as for the other policies, with their own
  checkpoint list `recovery_tab_policy_sha256` in the registry trust manifest. A theme or
  provider checkpoint never authenticates a tab policy.

## Deployment cutover still pending

The candidate template pins qualified `0.13.1-dev.39108033875.1` for existing
contribution/build/publication commands; see its exact
[qualification evidence](MARKETPLACE_CLI_QUALIFICATION_2026-10-18.md). The source
now removes replaced JavaScript business tooling and adds Rust standalone
metadata/submission/expiry commands. **Those new commands need a new CLI release
and qualification before full template deployment.** The older binary is not a
replacement pin for this expanded contract.

Merge/release/qualify the updated CLI, review the exact source/version/tag/digest,
and regenerate all registry delivery payload hashes. Reinspect actual remote
`main` and protections rather than reuse stale bootstrap approvals. If the trusted
base lacks helpers, deliver them first while preserving validation; then switch
workflows from that merged base and observe real hosted three-kind checks.
Preserve the required checks and explicitly agreed governance. No source cleanup
performs that deployment, assigns authority or activates desktop UI.

Author pins, official roots/feeds, signing environments, initial plugin releases
and packaged-client certification remain separate gates. Fresh runners rebuild
proof from verified remote evidence; raw recovery state is never uploaded/restored.
