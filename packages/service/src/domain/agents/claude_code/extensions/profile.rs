//! Claude Code as the active Claude profile runs it: that profile's
//! environment (which may move `CLAUDE_CONFIG_DIR`), so what the marketplace
//! lists and changes is what new Claude sessions load.

use crate::domain::agents::claude_code::config_dir;
use crate::domain::agents::claude_code::profiles::resolve_active_profile_env;
use crate::domain::agents::extensions::{CliRunner, ExtensionError};

pub fn active(cli: &CliRunner) -> Result<CliRunner, ExtensionError> {
    let (_, env) = resolve_active_profile_env().map_err(|error| {
        ExtensionError::failed(format!(
            "The active Claude Code profile cannot be used: {error}"
        ))
    })?;
    let env = env.unwrap_or_default();
    let config_dir = config_dir::for_env(Some(&env));
    Ok(cli.for_profile(env, Vec::new(), config_dir))
}
