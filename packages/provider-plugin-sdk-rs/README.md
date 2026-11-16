# cadencr-provider-sdk

Command harness for code-backed [Cadencr](https://github.com/merkr-software/CadencR)
agent provider packages.

A provider package is a native executable that Cadencr runs to talk to an
agent over [ACP](https://agentclientprotocol.com) v1. This crate implements the
executable's command contract — `models`, `run`, `version`, and the optional
`updates` / `update` / `host-integration` / `slash-commands` — so a connector only implements the
`CadencrProvider` trait.

[Documentation](https://cadencr.com/docs/provider-sdk/) ·
[crates.io](https://crates.io/crates/cadencr-provider-sdk) ·
[Rust API reference](https://docs.rs/cadencr-provider-sdk)

## Install

```toml
[dependencies]
cadencr-provider-sdk = "0.3"
agent-client-protocol = "3.4"
serde_json = "1"
```

The `0.3` series uses the ACP Rust SDK `3.4`, like `0.2`; connectors
migrating from `cadencr-provider-sdk 0.1` should align their
`agent-client-protocol` dependency with that version. The wire protocol
remains ACP v1. `0.3` adds the optional `host-integration` and `slash-commands`
commands and the `meta` helpers; `0.2` connectors compile unchanged.

## Implement the harness

This example returns a sample model so the discovery output has a valid
selector. Replace it with real native model discovery. The runtime method
explicitly fails until you implement the ACP adapter; this is a harness
example, not a complete agent connector.

```rust,no_run
use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use agent_client_protocol::schema::v1::SessionConfigOption;
use cadencr_provider_sdk::{run_cli, CadencrProvider, ProviderError};
use serde_json::json;

struct MyProvider;

impl CadencrProvider for MyProvider {
    fn models(
        &self,
        _cwd: &Path,
        _provider_args: &[OsString],
    ) -> Result<Vec<SessionConfigOption>, ProviderError> {
        Ok(serde_json::from_value(json!([{
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "example-model",
            "options": [{ "value": "example-model", "name": "Example model" }]
        }]))?)
    }

    fn run_acp(&self, _provider_args: &[OsString]) -> Result<ExitCode, ProviderError> {
        Err(ProviderError::new("Implement the native agent's ACP v1 adapter here"))
    }

    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }
}

fn main() -> ExitCode {
    run_cli(&MyProvider)
}
```

## Command contract

Cadencr executes the binary directly, without a shell. Provider-specific
arguments follow the reserved command arguments and reach your trait methods
as `OsString` values. Diagnostics belong on stderr; stdout is reserved for
JSON results or ACP messages.

| Command                                                               | Contract                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `models --format acp-config-options-v1 --cwd <absolute-path> [args…]` | prints the model selector as a JSON array of ACP `SessionConfigOption` |
| `run --protocol acp-v1 [args…]`                                       | speaks ACP v1 over stdio                                               |
| `version`                                                             | prints the connector version                                           |
| `updates --format cadencr-updates-v1`                                 | prints an update report (optional)                                     |
| `update [--version <v>]`                                              | installs a version (optional)                                          |
| `host-integration --format cadencr-host-integration-v1`               | prints the host conventions the provider opts into (optional)          |
| `slash-commands --format cadencr-slash-commands-v1 --cwd <abs-path>`  | prints the `/` commands for a directory (optional)                     |

The contract is language-neutral: any executable implementing it works, and
this crate is only the reference path. The normative specification is
[`docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md`](https://github.com/merkr-software/CadencR/blob/main/docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md).

## Model discovery and runtime

`models()` must return a non-empty `select` option with `category: "model"`.
Its model values must be unique and non-empty, and `currentValue` must name
one of them. Returning an empty array compiles but gives the host no usable
model selector. The host bounds model discovery to 10 seconds and 1 MiB of
stdout. The harness serializes your result; the host validates its semantics.

`run_acp()` implements the live ACP v1 session and translates the native
agent's events and configuration. The harness does not implement ACP for
you. Preserve the model and configuration IDs between discovery and runtime.

Users install and authenticate the native agent CLI through its own tools.
Cadencr does not collect or broker provider-account credentials. Return an
actionable `ProviderError` when native configuration is missing. I/O and JSON
errors convert to `ProviderError` with `?`.

## Optional updates

Override `updates()` to return `Ok(Some(UpdateReport))`, and `update(target)`
to install the requested native CLI version. Defaults report updates as
unsupported. `UpdateReport::builder()` exposes:

| Field                     | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `current_version`         | Installed version, or `None` when the native CLI is missing. |
| `latest_version`          | Newest installable version, if known.                        |
| `available_versions`      | Installable versions, newest first.                          |
| `supports_target_version` | Whether `update --version` accepts a listed version.         |

Updates must be noninteractive: the host closes stdin. Updating a native CLI
is separate from updating the connector package.

## Optional host integration

Override `host_integration()` to return `Ok(Some(HostIntegration))`; the
default prints `{}` (no integration). Every field is optional:

| Field                   | JSON                  | Meaning                                                                                          |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `compact_command`       | `compactCommand`      | Slash command (without `/`) the host sends as a prompt to compact the live conversation.         |
| `worktree_config_paths` | `worktreeConfigPaths` | Relative, normalized project paths copied into each new worktree (≤ 32).                         |
| `resume_command`        | `resumeCommand`       | `ResumeCommand { program, args }`: bare executable name; `{session_id}` is the only placeholder. |

The harness runs `HostIntegration::validate()` — the same rules the host
applies — before printing, so an invalid declaration fails the command
instead of being rejected later by the host. Only declare what the native
agent really supports over ACP: the session id the host substitutes is the
ACP `sessionId` your connector returned.

```rust,no_run
use cadencr_provider_sdk::{HostIntegration, ResumeCommand, SESSION_ID_PLACEHOLDER};

fn host_integration() -> HostIntegration {
    HostIntegration::builder()
        .compact_command("compact")
        .worktree_config_paths(vec![".example/config.json".into()])
        .resume_command(
            ResumeCommand::builder()
                .program("example")
                .args(vec!["--resume".into(), SESSION_ID_PLACEHOLDER.into()])
                .build(),
        )
        .build()
}
```

## Optional slash commands

Override `slash_commands(cwd)` to return the commands and skills the native
agent accepts as `/name` in a prompt for that directory, so Cadencr's `/`
menu is filled before an ACP session exists. It should print what your ACP
server would send in `available_commands_update` there. The default (`None`)
exits non-zero, which Cadencr reads as "not supported" (it then shows the list
the last live session advertised); an `Err` prints `{"message"}`, which the
`/` menu shows.

| `SlashCommand` field | Rule                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| `name`               | No leading `/`, no whitespace or control characters, 1-128 characters, unique.        |
| `description`        | Optional, at most 4096 characters; newlines and tabs are the only control characters. |
| `kind`               | `SlashCommandKind::Command` (default) or `SlashCommandKind::Skill`.                   |

The harness runs `validate_slash_commands()` (at most 1000 entries, the
host's rules) before printing. Do not start a live session from this command;
Cadencr bounds it to 10 seconds and caches the list for 30 seconds per
directory, refreshing it when a live session sends `available_commands_update`.

```rust,no_run
use cadencr_provider_sdk::{SlashCommand, SlashCommandKind};

fn slash_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand::builder().name("review").description("Review changes").build(),
        SlashCommand::builder()
            .name("deploy")
            .kind(SlashCommandKind::Skill)
            .build(),
    ]
}
```

## `_meta.cadencr` helpers

`cadencr_provider_sdk::meta` builds the provider-neutral `_meta.cadencr`
objects Cadencr reads on standard ACP structures. Each helper returns an ACP
`Meta` usable with typed structs (`SessionConfigSelectOption::new(..).meta(..)`)
or merged into raw JSON with `merge_meta`, which keeps existing `_meta` keys.

| Helper                                  | Attach to                                      | Effect in Cadencr                                                                 |
| --------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `permission_mode_meta(PermissionMode)`  | values of the `category: "mode"` select        | Mode chip / Shift+Tab; value order is the cycle order, the first is the edit mode |
| `access_mode_role_meta()`               | the access select option itself                | Marks it as the access control                                                    |
| `access_mode_meta(AccessMode)`          | values of that access select                   | Access chip and remembered workspace default                                      |
| `subagent_background_meta()`            | the sub-agent's launching `tool_call(_update)` | Keeps the sub-agent running past the call and the turn                            |
| `subagent_status_meta(status, summary)` | a later `tool_call_update`, same `toolCallId`  | Ends that background sub-agent                                                    |
| `slash_command_kind_meta(kind)`         | an `available_commands_update` entry           | Groups that live command with skills (`Skill`) or commands                        |

Emit the same `mode` / access selects (with the same `_meta`) from `models()`
and from live `configOptions`, so the catalog and the session agree.

## Validate and integrate

Exercise the built executable's `version`, model discovery and (if
implemented) `host-integration` commands, then
an actual ACP session once `run_acp()` is implemented. An installable package
also needs a provider descriptor, icon, and per-platform native artifacts;
see the [provider guide](https://cadencr.com/docs/provider-sdk/) and normative
contract linked above.

With the Cadencr CLI installed:

```bash
cadencr plugin validate /absolute/path/to/provider --descriptor /absolute/path/to/descriptor.json
```

Validation checks the package without executing the provider. It does not
replace real discovery/runtime tests. Build and test each declared platform.
For native functionality behind a web tab, use
[`cadencr-tab-backend`](https://cadencr.com/docs/tab-backend/) instead.

## Versioning

The crate is versioned independently of the Cadencr app.

## License

Apache-2.0
