//! Codex as the active Codex profile runs it: that profile's `CODEX_HOME` and
//! environment, so what the marketplace lists and changes is what new Codex
//! sessions load.

use std::path::{Path, PathBuf};

use crate::domain::agents::codex::profile_runtime::resolve_profile_for_selection;
use crate::domain::agents::codex::profiles::default_home;
use crate::domain::agents::extensions::{CliRunner, ExtensionError};

const CODEX_HOME: &str = "CODEX_HOME";

pub fn active(cli: &CliRunner) -> Result<CliRunner, ExtensionError> {
    let profile = resolve_profile_for_selection(None).map_err(|error| {
        ExtensionError::failed(format!("The active Codex profile cannot be used: {error}"))
    })?;
    let home = home_of(profile.env.get(CODEX_HOME).map(String::as_str));
    Ok(cli.for_profile(profile.env, profile.env_unset, home))
}

/// A profile's own home when it sets one, else the default Codex home.
fn home_of(profile_home: Option<&str>) -> Option<PathBuf> {
    profile_home.map(PathBuf::from).or_else(default_home)
}

/// Whether `command` runs from `home`'s plugin cache.
pub fn in_plugin_cache(command: &str, home: Option<&Path>) -> bool {
    command.contains("/.codex/plugins/cache/")
        || home
            .is_some_and(|home| Path::new(command).starts_with(home.join("plugins").join("cache")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_home_wins_over_the_default() {
        assert_eq!(
            home_of(Some("/profiles/work")),
            Some(PathBuf::from("/profiles/work"))
        );
        assert_eq!(home_of(None), default_home());
    }

    #[test]
    fn plugin_launchers_are_found_in_a_profile_home_too() {
        let home = Path::new("/profiles/work");
        assert!(in_plugin_cache(
            "/profiles/work/plugins/cache/acme/launch",
            Some(home)
        ));
        assert!(in_plugin_cache(
            "/Users/me/.codex/plugins/cache/acme/launch",
            None
        ));
        assert!(!in_plugin_cache("npx", Some(home)));
    }
}
