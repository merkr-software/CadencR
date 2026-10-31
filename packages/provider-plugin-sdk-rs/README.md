# cadencr-provider-sdk

Command harness for code-backed [Cadencr](https://github.com/merkr-software/CadencR)
agent provider packages.

A provider package is a native executable that Cadencr runs to talk to an
agent over [ACP](https://agentclientprotocol.com) v1. This crate implements the
executable's command contract — `models`, `run`, `version`, and the optional
`updates` / `update` — so a connector only implements the
`CadencrProvider` trait.

[Documentation](https://cadencr.com/docs/provider-sdk/) ·
[crates.io](https://crates.io/crates/cadencr-provider-sdk) ·
[Rust API reference](https://docs.rs/cadencr-provider-sdk)

## Install

```toml
[dependencies]
cadencr-provider-sdk = "0.2"
agent-client-protocol = "3.4"
serde_json = "1"
```

The `0.2` series uses the ACP Rust SDK `3.4`; connectors migrating from
`cadencr-provider-sdk 0.1` should align their `agent-client-protocol`
dependency with that version. The wire protocol remains ACP v1.

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

## Validate and integrate

Exercise the built executable's `version` and model discovery commands, then
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
