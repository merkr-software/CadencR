//! Claude Code as the active Claude profile runs it: that profile's
//! environment (which may move `CLAUDE_CONFIG_DIR`), so what the marketplace
//! lists and changes is what new Claude sessions load.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;

use crate::domain::agents::claude_code::profiles::resolve_active_profile_env;
use crate::domain::agents::extensions::CliRunner;

pub fn active(cli: &CliRunner) -> CliRunner {
    let env = resolve_active_profile_env().1.unwrap_or_default();
    let config_dir = config_dir(&env, |key| std::env::var_os(key), dirs::home_dir());
    cli.for_profile(env, Vec::new(), config_dir)
}

/// `CLAUDE_CONFIG_DIR` as the profile, then the process, sets it; else
/// `.claude` under the profile's `HOME`, then the user's home.
fn config_dir(
    profile_env: &HashMap<String, String>,
    process_env: impl Fn(&str) -> Option<OsString>,
    user_home: Option<PathBuf>,
) -> Option<PathBuf> {
    profile_env
        .get("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| process_env("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| {
            profile_env
                .get("HOME")
                .map(PathBuf::from)
                .or(user_home)
                .map(|home| home.join(".claude"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn the_profile_config_dir_wins_over_the_process() {
        let process = |_: &str| Some(OsString::from("/process/claude"));
        let dir = config_dir(
            &env(&[("CLAUDE_CONFIG_DIR", "/profiles/work")]),
            process,
            None,
        );
        assert_eq!(dir, Some(PathBuf::from("/profiles/work")));
    }

    #[test]
    fn the_process_config_dir_comes_next() {
        let process = |_: &str| Some(OsString::from("/process/claude"));
        let dir = config_dir(&env(&[("HOME", "/profiles/home")]), process, None);
        assert_eq!(dir, Some(PathBuf::from("/process/claude")));
    }

    #[test]
    fn a_profile_home_moves_the_default_config_dir() {
        let none = |_: &str| None;
        let user = Some(PathBuf::from("/Users/me"));
        assert_eq!(
            config_dir(&env(&[("HOME", "/profiles/home")]), none, user.clone()),
            Some(PathBuf::from("/profiles/home/.claude"))
        );
        assert_eq!(
            config_dir(&env(&[]), none, user),
            Some(PathBuf::from("/Users/me/.claude"))
        );
    }
}
