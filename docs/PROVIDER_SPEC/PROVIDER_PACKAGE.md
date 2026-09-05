# Cadencr code-backed provider package contract

> - **Status:** Local v1 code-and-icon plus managed package/install/conformance backend implemented; release trust pins and marketplace UI deferred
> - **Contract version:** `acp-config-options-v1` + `acp-v1`
> - **Reference SDK:** `packages/provider-plugin-sdk-rs/`
> - **External reference provider:** `cadencr-plugin-provider-pi` — native `pi --mode rpc`, no `pi-acp`

## Why providers require code

ACP v1 intentionally exposes models and other session configuration only after
`session/new`. Cadencr does not allow a user to start a session before choosing
from a verified model list. A descriptor therefore cannot turn an arbitrary ACP
process into a provider by itself.

A provider package must include executable code that owns both mappings:

1. provider-native model discovery and parsing into the ACP v1 configuration
   shape Cadencr understands before a session exists;
2. provider-native runtime adaptation into ACP v1 for the live session.

The host remains provider-neutral. Provider-specific CLI flags, RPC calls,
model identifiers, aliases, and parsing stay in the package executable.

## Provider account configuration

Provider-account authentication is wholly outside Cadencr. Before installing or
running a connector, the user configures and authenticates the provider's native
CLI using that provider's own commands and credential storage. Cadencr does not:

- collect, store, copy, broker, or render provider credentials;
- invoke ACP authentication methods for generic installed/marketplace connectors;
- admit or reject a package based on an advertised authentication method;
- put credentials or provider-account authentication policy in the package,
  descriptor, argument vector, or environment.

The connector's `README.md` may document the native prerequisite command, and
`models` or `run` must return an actionable error when native configuration is
missing. Cadencr's own loopback API token and package/index signature and
checksum verification are independent host-security mechanisms and remain
required.

## Required executable interface

Cadencr invokes the installed executable directly, never through a shell.
Descriptor arguments are appended after the reserved command arguments.

| Command                                                                          | Purpose                                 | Required result                       |
| -------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| `models --format acp-config-options-v1 --cwd <absolute-path> [provider-args...]` | Discover models before session creation | One JSON array on `stdout`; exit `0`  |
| `run --protocol acp-v1 [provider-args...]`                                       | Start the live agent                    | ACP v1 JSON-RPC over `stdin`/`stdout` |
| `version`                                                                        | Report package implementation version   | One version string on `stdout`        |

Diagnostics belong on `stderr`. The `models` command must not write logs,
progress, or banners to `stdout`.

### Resource limits

| Limit               | Host behavior                                               |
| ------------------- | ----------------------------------------------------------- |
| `models` duration   | Terminated after 10 seconds                                 |
| `stdout`            | Rejected above 1 MiB                                        |
| `stderr`            | Drained and bounded; contents are never returned by the API |
| Shell interpolation | Forbidden                                                   |

## `models` output

The output is a JSON array of ACP v1 `SessionConfigOption` objects. It must
contain a non-empty `select` option whose `category` is `model`.

```json
[
  {
    "id": "model",
    "name": "Model",
    "description": "Select the model before starting the session",
    "category": "model",
    "type": "select",
    "currentValue": "anthropic/claude-opus-4-1",
    "options": [
      {
        "value": "anthropic/claude-opus-4-1",
        "name": "Anthropic: Claude Opus 4.1",
        "description": "200000 token context window",
        "_meta": {
          "cadencr": {
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high"],
            "defaultEffortLevel": "medium",
            "supportsAdaptiveThinking": false,
            "supportsFastMode": false,
            "supportsAutoMode": false
          }
        }
      }
    ]
  }
]
```

### Validation rules

- `options` must contain at least one model.
- Every `value` is an opaque provider-owned model ID. IDs must be non-empty,
  trimmed, and unique.
- `currentValue` is the provider's default and must name one returned option.
- The option `id` is also provider-owned. The live ACP session must advertise
  the same selector ID.
- Grouped and ungrouped ACP select choices are accepted.
- Descriptors still cannot declare model data.
- `_meta.cadencr` is optional host presentation metadata. Unknown or invalid
  values are rejected rather than guessed.

`ModelCatalogEntry` is a Cadencr view of this ACP data, not a second package
schema. This keeps the pre-session contract close to ACP and makes an ACP-native
provider mapping small.

## Session-time reconciliation

The pre-session result is necessary for selection but is not trusted forever.
Immediately after `session/new`, before the first prompt, Cadencr:

1. finds the live ACP selector using the ID returned by `models`;
2. verifies that the selected model still exists in its live choices;
3. sends `session/set_config_option` with the selected value;
4. replaces its snapshot with the authoritative response;
5. verifies that the response confirms the selected model.

Any missing selector, stale model, refusal, or mismatched response aborts the
session before `session/prompt`. Cadencr never sends a speculative first prompt
to discover what models exist.

## Durable ACP v1 resume

Durable resume remains handshake-owned rather than descriptor-owned. The host
persists resume IDs only after the connector advertised stable resume or legacy
load, rechecks a stored ID against a newly spawned connector, and fails visibly
rather than silently creating empty provider context. It uses this precedence:

1. return an opaque, stable ID from `session/new`;
2. prefer `sessionCapabilities.resume` plus `session/resume` when advertised;
3. fall back to legacy `loadSession` plus `session/load` for compatible agents;
4. reject missing, stale, workspace-mismatched, or unsupported IDs instead of
   calling `session/new`;
5. return the same complete configuration snapshot shape as `session/new` from
   either restore method;
6. advertise `sessionCapabilities.close` and implement `session/close` when the
   connector can release an active native session cleanly.

Cadencr will send an advertised close request with a bounded timeout before it
drains and terminates the connector process. Resume and close support never
appears in the descriptor. `session/resume` is preferred because it restores
provider context without transcript replay; Cadencr already owns the visible
transcript.

## Rust SDK

The SDK supplies the command parser and ACP v1 output types. Provider authors
implement only the provider-owned discovery and runtime bridge:

```rust
use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use agent_client_protocol::schema::v1::SessionConfigOption;
use cadencr_provider_sdk::{run_cli, CadencrProvider, ProviderError};

struct MyProvider;

impl CadencrProvider for MyProvider {
    fn models(
        &self,
        cwd: &Path,
        provider_args: &[OsString],
    ) -> Result<Vec<SessionConfigOption>, ProviderError> {
        // Call and parse the provider-native model API here.
        todo!()
    }

    fn run_acp(&self, provider_args: &[OsString]) -> Result<ExitCode, ProviderError> {
        // Speak ACP directly or delegate to an ACP adapter here.
        todo!()
    }

    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }
}

fn main() -> ExitCode {
    run_cli(&MyProvider)
}
```

Rust is the supported reference implementation, not a protocol requirement.
A package written in another language is compatible only if it implements the
same executable contract and passes the same conformance tests.

## Pi reference mapping

The independent reference connector owns the ACP server and maps native
`pi --mode rpc` directly; it does not use `pi-acp`:

- `models` launches `pi --mode rpc --no-session --no-approve` in the requested
  workspace, calls `get_available_models` and `get_state`, and emits the exact
  `${provider}/${id}` values accepted by its live ACP model selector;
- `run` starts the connector's ACP v1 stdio server, and each ACP session owns a
  persistent Pi RPC child in the requested workspace;
- native `set_model`, thinking-level, message/thinking streams, tool lifecycle,
  permissions, cancellation, commands, context/cost, compaction, and queue
  controls map to the closest standard ACP v1 shapes without host-side Pi
  branches;
- durable restore validates a workspace-bound opaque ID and starts a new
  `pi --mode rpc --session <native-id>` process;
- `CADENCR_PI_COMMAND` may override the native Pi executable, without introducing
  a second ACP adapter dependency.

`cadencr-plugin-provider-pi` is a separately versioned, dependency-free Node 22
source repository and integration reference. Cadencr sees only its signed
package/index metadata and the provider-neutral executable contract. An end
user never clones or modifies Cadencr, and the connector's existence does not
justify a `pi` branch, dependency, asset, model parser, or release step in the
registry, generic adapter, catalog, desktop, or Cadencr build.

## Developer workspace generator

Settings → Providers → **Add provider** creates the local authoring workflow;
it is not a marketplace installer. Cadencr creates:

- an ordinary `kind=user` project under
  `~/.cadencr/provider-workspaces/<provider-id>/`;
- an ordinary `ws-session` conversation with no forced pane layout, worktree
  mode, provider, or model;
- a Git repository with an initial Cadencr-authored commit;
- `README.md` for the developer and `INSTRUCTION.md` containing the executable,
  model discovery, ACP v1, icon, testing, and security requirements for their agent;
- a descriptor prepared to load a connector-owned root `icon.svg`, which the
  implementing agent adds inside the connector repository rather than to
  Cadencr's source tree;
- a restart-gated local descriptor targeting the stable generated build output
  `bin/provider` (`bin/provider.exe` on Windows).

The developer asks their normal configured agent to read `INSTRUCTION.md` and
implement the connector. If their normal worktree workflow was used, they merge
the changes back into the project checkout and build the stable executable
there. They must restart Cadencr between connector changes before testing:
provider registration is fixed for the service process lifetime, and hot reload
is deliberately unsupported.

The generated repository is language-neutral. Rust and
`cadencr-provider-sdk` are the supported reference path, but another language
is compatible when its executable implements this same command and ACP v1
contract. No arbitrary executable, argument, or environment form is exposed to
normal users.

The checked-in authoring template at
`packages/service/src/domain/agents/providers/development/templates/INSTRUCTION.md`
is the exact file copied into new repositories. Keep changes to the executable
contract synchronized with that template so provider authors and the public
specification receive the same requirements.

### Local icon contract

The connector repository owns its branding. Provider authors add `icon.svg` at
the repository root; they never add an ID, import, or asset to Cadencr's source
tree. The generated descriptor already declares `agent.icon: "icon.svg"` and an
absolute host-only `installation.assets.directory` pointing at that repository.

On startup, Cadencr canonicalizes both paths, refuses symlink/path escapes,
accepts only Chromium-renderable image extensions, caps the file at 128 KiB,
and exposes only a base64 `data:image/...` value through the provider catalog.
The renderer never receives the local directory. A missing or invalid icon is a
packaging diagnostic from `GET /api/agents/installed-providers` with a neutral
UI fallback; it does not make an otherwise runnable connector unavailable.

## Managed package/index contract

The executable contract now has a strict, versioned downloadable-package
envelope and backend in `providers/installed/managed/`. It is intentionally a
loopback service API with no normal-user marketplace surface. A release must
still provision its real signing key and HTTPS blocklist source before it can
admit third-party packages.

### Package/index contract

The portable agent payload remains a lossless ACP Registry entry. A separate,
versioned Cadencr envelope supplies host policy without adding runtime
capabilities to that payload:

| Required data | Rule                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Identity      | Normalized provider ID and exact semantic package version; built-in IDs and aliases remain reserved.               |
| Compatibility | Explicit minimum and optional maximum Cadencr version.                                                             |
| Target        | Exactly one selected distribution matching the current OS and architecture.                                        |
| Artifact      | Immutable archive URL plus required SHA-256 for binary archives; moving versions and ranges are rejected.          |
| Executable    | Relative path inside the archive plus an argument array; no shell command.                                         |
| Assets        | Relative, bounded icon plus optional readme/license paths inside the same package root.                            |
| Environment   | Non-secret launch configuration only. Provider credentials and provider-account authentication data are forbidden. |
| Trust         | Signed registry/index entry and publisher identity, kept separate from ACP conformance.                            |

Package parsing is lossless for portable ACP root fields and strict for the
Cadencr host envelope. Unknown host-policy fields fail closed rather than being
silently ignored. Contract v1 validates deterministic package ordering, exact
semantic versions, inclusive application compatibility, every declared binary
target, mandatory SHA-256, HTTPS artifacts, bounded relative executable/assets,
and the ban on credential/authentication data. Resolution selects only the
exact current ACP Registry platform key; it never falls back to another target
or to `npx`/`uvx`.

The detached Ed25519 signature covers canonical compact JSON bytes for this
validated envelope. Schema validation alone does not establish trust: only the
host-owned keyring can turn it into a verified index consumable by the
installer. Release builds provision the key id/public key and blocklist URL at
compile time through `CADENCR_MANAGED_PROVIDER_KEY_ID`,
`CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64`, and
`CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL`. A build without those pins fails
closed with `TRUST_NOT_CONFIGURED`; request-supplied public keys and source URLs
are never roots of trust.

### Installation transaction

For install or update, the backend performs this ordered transaction:

1. choose the exact compatible current-platform distribution;
2. download into a bounded staging directory outside the active installation;
3. verify the signed index/entry and artifact SHA-256 before extraction;
4. reject path traversal, absolute paths, duplicate entries, escaping symlinks,
   oversized entries/archives, and unsupported file types;
5. ensure every executable and declared asset canonicalizes inside the staged
   package root, and apply restrictive file/directory permissions;
6. run the conformance probes below against the staged executable;
7. atomically rename the staged tree into
   `<settings-sibling>/provider-installations/<id>/<version>/<sha256>/`, then
   atomically write `state.json`, the sole authoritative activation pointer;
8. derive the startup descriptor from that desired state. A projection failure
   is recoverable: startup reconciles it before descriptor scanning and
   suppresses a stale managed descriptor if reconciliation still fails;
9. record source, digest, installed version, previous version, conformance
   receipt, activation state, and timestamps in durable install history;
10. leave prior immutable versions, history, and redacted quarantine evidence
    retained. Garbage collection and an explicit retention cap are deferred;
    current uninstall removes activation, not audit or rollback bytes.

A failure before activation removes only staging data and leaves the current
version unchanged. Cleanup failures are returned and the stable failure gate is
written to the private quarantine ledger; they are not log-only. Update uses a
compare-and-swap on the complete prior activation, including enablement, so a
concurrent remove/update/enable cannot resurrect or overwrite state. Rollback
re-verifies the retained signed index with the current host keyring, checks the
complete payload manifest and blocklist, reruns prompt-free conformance in a new
empty workspace, checks that conformance did not mutate package bytes, and only
then performs the same activation compare-and-swap.

Disable, uninstall, update, and rollback never delete Cadencr sessions or
transcripts. An active provider ID remains reserved until restart, matching the
immutable runtime-registry rule. Managed descriptors cannot be modified through
the local-descriptor lifecycle API; callers receive `USE_MANAGED_PROVIDER_API`.

### Bounded conformance before activation

Conformance is compatibility evidence, not a trust or authentication decision:

| Probe                | Required assertion                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | Exits successfully within bounds and returns one connector version.                                                                                         |
| `models`             | Returns a verified non-empty model selector/default within the existing 10-second and 1-MiB limits.                                                         |
| `initialize`         | Negotiates ACP v1 and reports parseable capabilities.                                                                                                       |
| Disposable session   | `session/new` returns an ID and a live selector compatible with pre-session discovery.                                                                      |
| Model reconciliation | The selected model can be set and is authoritatively confirmed before prompting.                                                                            |
| Cleanup              | The disposable session is closed when advertised and the complete process tree is drained within a bound without sending a billable prompt.                    |
| Resume compatibility | If advertised, `session/resume` is probed; legacy `session/load` is tested only as fallback. Unsupported explicit resume must fail rather than start fresh. |
| Close compatibility  | If advertised, `session/close` releases the disposable session within a bound.                                                                              |

The installer records stable rejection/quarantine codes and a non-secret
conformance receipt: exact connector version, ordered model IDs/default and
selector ID, advertised resume/load/close probe outcomes, explicit unprobed
prompt state, and whether an OS sandbox was applied. It never invokes or tests
provider-account authentication; a preconfigured native CLI is a user
prerequisite, and missing configuration is an actionable availability error.

### Registry, blocklist, and process policy

The backend now provides:

- signed-index ingestion through a host-pinned Ed25519 keyring, with the exact
  signed envelope retained in every immutable receipt;
- a startup-fetched, bounded, signed HTTPS blocklist cache. Network failure may
  use a still-valid verified cache; matching, corrupt, or expired cached policy
  fails launch closed. When a blocklist URL is configured, a missing verified
  cache also refuses install/launch. Cache publication is serialized and rejects
  older or conflicting same-timestamp policy, including after cache expiry. A
  newly verified policy may repair an invalid/untrusted cache. Inventory reports missing/verified/invalid cache state,
  signer, expiry, and safe failure code;
- complete payload-manifest, checksum, receipt, signed-entry, and blocklist
  re-verification at rollback and immediately before both `models` and `run`;
- direct execution with a sanitized inherited environment, empty conformance
  workspace, bounded one-shot commands and output, process-tree termination,
  and CPU/memory limits where the OS supports them. Inventory reports unavailable
  controls honestly; this is not a filesystem/network sandbox;
- loopback install, update, rollback, enable/disable, uninstall, inventory, and
  blocklist-refresh endpoints with durable state, history, and redacted
  quarantine evidence. Mutations are restart-gated because the runtime registry
  remains immutable for one service process.

The normal-user marketplace browser and install/manage UI is explicitly
deferred. The remaining release gates are provisioning a real reviewed signing
key and blocklist URL, deciding the OS sandbox requirement, and exercising a
real signed package end-to-end in a packaged app. The local developer substrate
remains separate and is not a general-purpose "add any CLI" flow.

### Local integrity boundary

"Immutable revision" means version/digest-addressed storage which the installer
does not overwrite with different package contents. It does not mean OS-enforced
read-only storage. Launch checks re-read the signed receipt and package bytes,
but execution still opens the executable by pathname afterward. A process with
the same user's filesystem privileges can race that check or modify connector
dependencies after it; this implementation is not tamper-proof against an
already-compromised local user account. Executing a verified executable handle
alone would also not pin a script interpreter's subsequently loaded files.

Keep launch-time verification on every `models` and `run` invocation. Do not
describe it as atomic verify-and-execute or treat process containment as a
filesystem/network sandbox. Stronger local isolation remains part of the
explicit sandbox/release-policy decision, not a solved guarantee of this backend.

### Managed lifecycle API

All mutations are host-authenticated and loopback-only:

| Operation | Endpoint |
| --- | --- |
| Inventory | `GET /api/agents/managed-providers` |
| Install | `POST /api/agents/managed-providers` |
| Update | `POST /api/agents/managed-providers/{provider_id}/update` |
| Rollback | `POST /api/agents/managed-providers/{provider_id}/rollback` |
| Enable/disable | `PUT /api/agents/managed-providers/{provider_id}/enabled` |
| Remove activation | `DELETE /api/agents/managed-providers/{provider_id}` |
| Refresh kill switch | `POST /api/agents/managed-providers/blocklist/refresh` |

Install/update requests carry the signed index envelope, provider id, and exact
version—not a public key, registry URL, arbitrary executable, or credential.
Responses report active/current-versus-next-restart state, retained history,
quarantine records, blocklist health, and applied/unavailable process controls.

### Review hardening invariants

- TAR parsing counts all physical headers toward the 4,096-entry limit and
  bounds the entire decompressed stream, including padding and trailing data.
  GNU longname and local PAX metadata are limited to 64 KiB each; nonempty
  directory bodies, global/link/sparse extensions, and differing PAX/physical
  sizes are rejected. Archive metadata never applies ownership or extended
  attributes to installed files.
- Reinstalling an identical revision may use a newer signed catalog containing
  unrelated package changes. The selected signed package and immutable launch,
  asset, checksum, and payload metadata must still agree; the original receipt
  and its signed evidence are retained.
- Quarantine append operations serialize the complete read/modify/write cycle.
  A corrupt provider state, receipt, or quarantine ledger produces per-entry
  `error_code` / redacted `error` diagnostics instead of hiding other installs or
  failing an unrelated successful mutation's response.
- Disable does not need an intact receipt or payload. It retires the runtime
  descriptor while retaining disabled desired state and identity reservation.
  Re-enable must still pass verification; changes require a restart.
- One-shot command cleanup retains process-tree ownership even after the parent
  exits, so descendants holding stdout/stderr cannot survive a capture timeout.

- Startup-registration readiness in inventory uses the same receipt identity,
  payload, and descriptor validation as startup reconciliation. It is distinct
  from launch authorization: signatures and blocklist policy are still checked
  at each launch. Disabled IDs remain reserved even without a descriptor.
- Mutation responses inspect only the affected provider. Full inventory builds
  one startup-ID lookup, and expensive inventory, launch-verification, and
  admission filesystem work is dispatched to blocking workers.
- Concurrent commits of an identical immutable revision verify and reuse the
  winning destination; a differing revision's metadata or payload remains an
  error. No new UI or hot reload is implied by these backend changes.
