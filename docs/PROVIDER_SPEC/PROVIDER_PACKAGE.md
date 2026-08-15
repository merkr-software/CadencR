# Cadencr code-backed provider package contract

> - **Status:** Local v1 contract implemented; marketplace packaging and signing are future work
> - **Contract version:** `acp-config-options-v1` + `acp-v1`
> - **Reference SDK:** `packages/provider-plugin-sdk-rs/`
> - **Reference provider:** `packages/pi-provider/`

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

## Required executable interface

Cadencr invokes the installed executable directly, never through a shell.
Descriptor arguments are appended after the reserved command arguments.

| Command | Purpose | Required result |
| --- | --- | --- |
| `models --format acp-config-options-v1 --cwd <absolute-path> [provider-args...]` | Discover models before session creation | One JSON array on `stdout`; exit `0` |
| `run --protocol acp-v1 [provider-args...]` | Start the live agent | ACP v1 JSON-RPC over `stdin`/`stdout` |
| `version` | Report package implementation version | One version string on `stdout` |

Diagnostics belong on `stderr`. The `models` command must not write logs,
progress, or banners to `stdout`.

### Resource limits

| Limit | Host behavior |
| --- | --- |
| `models` duration | Terminated after 10 seconds |
| `stdout` | Rejected above 1 MiB |
| `stderr` | Drained and bounded; contents are never returned by the API |
| Shell interpolation | Forbidden |

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

`cadencr-pi-provider` demonstrates a non-ACP discovery source:

- `models` launches `pi --mode rpc --no-session` in the requested workspace;
- it sends `get_available_models` and `get_state`;
- it maps Pi model IDs to the exact `${provider}/${id}` values used by
  `pi-acp`'s live `model` selector;
- `run` delegates ACP stdio to `pi-acp`;
- `CADENCR_PI_PATH` and `CADENCR_PI_ACP_PATH` can override the two binaries.

This provider-specific knowledge lives entirely in `packages/pi-provider/`.
Neither the registry, generic adapter, catalog, nor desktop branches on `pi`.

## Developer workspace generator

Settings → Providers → **Add provider** creates the local authoring workflow;
it is not a marketplace installer. Cadencr creates:

- an ordinary `kind=user` project under
  `~/.cadencr/provider-workspaces/<provider-id>/`;
- an ordinary `ws-session` conversation with no forced pane layout, worktree
  mode, provider, or model;
- a Git repository with an initial Cadencr-authored commit;
- `README.md` for the developer and `INSTRUCTION.md` containing the executable,
  model discovery, ACP v1, testing, and security requirements for their agent;
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

## Marketplace package work still required

The executable contract does not yet define the downloadable archive format.
Before public marketplace installation, the package layer still needs:

- signed identity and publisher metadata;
- platform-specific binary and asset entries;
- hashes, extraction policy, permissions, and quarantine rules;
- an icon/license/readme asset contract;
- conformance execution before activation;
- atomic install, upgrade, rollback, and uninstall semantics.

Until those controls exist, provider descriptors and lifecycle endpoints are a
backend/developer substrate, not a general-purpose "add any CLI" desktop flow.
