//! The SDK command contract (`models`, `run`, `version`, `updates`, `update`,
//! `host-integration`, `slash-commands`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use agent_client_protocol::schema::v1::SessionConfigOption;
use cadencr_provider_sdk::{
    CadencrProvider, HostIntegration, ProviderError, SlashCommand, UpdateReport,
};

use crate::access::AccessMode;
use crate::cli::models::{catalog_entries, default_model_id, list_models, model_select_option};
use crate::cli::{binary, block_on, updates};
use crate::host_integration::cursor_host_integration;
use crate::modes;
use crate::proxy::{self, Launch};
use crate::slash_commands::cursor_slash_commands;

pub struct CursorProvider;

impl CadencrProvider for CursorProvider {
    fn models(
        &self,
        cwd: &Path,
        _provider_args: &[OsString],
    ) -> Result<Vec<SessionConfigOption>, ProviderError> {
        let binary = binary::resolve_binary()?;
        let models = block_on(list_models(&binary, Some(cwd)))?;
        let current = default_model_id(&models)
            .ok_or_else(|| ProviderError::new("`agent models` returned no models"))?;
        // Same order and `_meta` as the live `configOptions` view.
        [
            modes::catalog_option(),
            model_select_option(&catalog_entries(&models), current),
            AccessMode::default().config_option(),
        ]
        .into_iter()
        .map(|option| serde_json::from_value(option).map_err(ProviderError::from))
        .collect()
    }

    fn run_acp(&self, provider_args: &[OsString]) -> Result<ExitCode, ProviderError> {
        let launch = Launch {
            binary: binary::resolve_binary()?,
            extra_args: provider_args.to_vec(),
        };
        block_on(async move {
            proxy::run(launch).await.map_err(|error| {
                ProviderError::new(format!(
                    "could not start Cursor Agent (`agent acp`): {error}"
                ))
            })
        })
    }

    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    fn updates(&self) -> Result<Option<UpdateReport>, ProviderError> {
        block_on(updates::report()).map(Some)
    }

    fn update(&self, target: Option<&str>) -> Result<Option<String>, ProviderError> {
        block_on(updates::update(target))
    }

    fn host_integration(&self) -> Result<Option<HostIntegration>, ProviderError> {
        Ok(Some(cursor_host_integration()))
    }

    /// A filesystem scan: never starts `agent acp` (see `slash_commands.rs`).
    fn slash_commands(&self, cwd: &Path) -> Result<Option<Vec<SlashCommand>>, ProviderError> {
        // Node's `os.homedir()`, which Cursor uses, reads `$HOME` on Unix.
        let home = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from);
        Ok(Some(cursor_slash_commands(cwd, home.as_deref())))
    }
}
