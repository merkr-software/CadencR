//! The directory Claude Code keeps its configuration in for a profile:
//! settings, agents, skills, plugins and the `projects/` session transcripts.
//!
//! A profile may move it (`CLAUDE_CONFIG_DIR`, or another `HOME`), so every
//! reader resolves it here, from the environment the CLI runs with, instead of
//! assuming `~/.claude`. The rule is the same on macOS and Linux: Claude Code
//! does not follow XDG.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::domain::imports::claude_code_jsonl::encode_project_path;
use crate::error::AppError;

const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";
const USER_FILE: &str = ".claude.json";

/// Claude Code's directory under `profile_env` (none: the service's own
/// environment). `None` only when no home directory resolves.
pub(crate) fn for_env(profile_env: Option<&HashMap<String, String>>) -> Option<PathBuf> {
    resolve(
        profile_env.unwrap_or(&HashMap::new()),
        |key| std::env::var_os(key),
        dirs::home_dir(),
    )
}

/// Claude Code's user file (`.claude.json`) under `profile_env` (none: the
/// service's own environment).
pub(crate) fn user_file_for_env(profile_env: Option<&HashMap<String, String>>) -> Option<PathBuf> {
    resolve_user_file(
        profile_env.unwrap_or(&HashMap::new()),
        |key| std::env::var_os(key),
        dirs::home_dir(),
    )
}

/// Claude Code's directory under the named profile (none: the active one).
pub(crate) fn for_profile(profile: Option<&str>) -> Result<PathBuf, AppError> {
    let (name, env) = super::profiles::resolve_profile_env_by_name(profile)?;
    for_env(env.as_ref()).ok_or_else(|| {
        AppError::internal(format!(
            "could not resolve Claude Code's configuration directory for profile '{name}': no home directory"
        ))
    })
}

/// Where Claude Code writes the session transcripts of `project_path`.
pub(crate) fn transcripts_dir(config_dir: &Path, project_path: &Path) -> PathBuf {
    config_dir
        .join("projects")
        .join(encode_project_path(project_path))
}

/// `CLAUDE_CONFIG_DIR` as the profile, then the process, sets it; else
/// `.claude` under the profile's `HOME`, then the user's home.
fn resolve(
    profile_env: &HashMap<String, String>,
    process_env: impl Fn(&str) -> Option<OsString>,
    user_home: Option<PathBuf>,
) -> Option<PathBuf> {
    explicit_dir(profile_env, process_env)
        .or_else(|| home(profile_env, user_home).map(|home| home.join(".claude")))
}

/// Claude Code's user file (`.claude.json`, user and per-project MCP servers):
/// in `CLAUDE_CONFIG_DIR` when it is set, else in the home itself, beside
/// `.claude`.
fn resolve_user_file(
    profile_env: &HashMap<String, String>,
    process_env: impl Fn(&str) -> Option<OsString>,
    user_home: Option<PathBuf>,
) -> Option<PathBuf> {
    explicit_dir(profile_env, process_env)
        .or_else(|| home(profile_env, user_home))
        .map(|dir| dir.join(USER_FILE))
}

fn explicit_dir(
    profile_env: &HashMap<String, String>,
    process_env: impl Fn(&str) -> Option<OsString>,
) -> Option<PathBuf> {
    profile_env
        .get(CONFIG_DIR_VAR)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            process_env(CONFIG_DIR_VAR)
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from)
        })
}

fn home(profile_env: &HashMap<String, String>, user_home: Option<PathBuf>) -> Option<PathBuf> {
    profile_env.get("HOME").map(PathBuf::from).or(user_home)
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
        let dir = resolve(
            &env(&[("CLAUDE_CONFIG_DIR", "/profiles/work")]),
            process,
            None,
        );
        assert_eq!(dir, Some(PathBuf::from("/profiles/work")));
    }

    #[test]
    fn the_process_config_dir_comes_next() {
        let process = |_: &str| Some(OsString::from("/process/claude"));
        let dir = resolve(&env(&[("HOME", "/profiles/home")]), process, None);
        assert_eq!(dir, Some(PathBuf::from("/process/claude")));
    }

    #[test]
    fn a_profile_home_moves_the_default_config_dir() {
        let none = |_: &str| None;
        let user = Some(PathBuf::from("/Users/me"));
        assert_eq!(
            resolve(&env(&[("HOME", "/profiles/home")]), none, user.clone()),
            Some(PathBuf::from("/profiles/home/.claude"))
        );
        assert_eq!(
            resolve(&env(&[]), none, user),
            Some(PathBuf::from("/Users/me/.claude"))
        );
    }

    #[test]
    fn an_empty_config_dir_is_unset() {
        let process = |_: &str| Some(OsString::new());
        let user = Some(PathBuf::from("/home/me"));
        assert_eq!(
            resolve(&env(&[("CLAUDE_CONFIG_DIR", "")]), process, user),
            Some(PathBuf::from("/home/me/.claude"))
        );
    }

    #[test]
    fn the_user_file_follows_the_config_dir_else_sits_in_the_home() {
        let none = |_: &str| None;
        let user = Some(PathBuf::from("/Users/me"));
        assert_eq!(
            resolve_user_file(
                &env(&[("CLAUDE_CONFIG_DIR", "/profiles/work")]),
                none,
                user.clone()
            ),
            Some(PathBuf::from("/profiles/work/.claude.json"))
        );
        assert_eq!(
            resolve_user_file(&env(&[("HOME", "/profiles/home")]), none, user.clone()),
            Some(PathBuf::from("/profiles/home/.claude.json"))
        );
        assert_eq!(
            resolve_user_file(&env(&[]), none, user),
            Some(PathBuf::from("/Users/me/.claude.json"))
        );
    }

    #[test]
    fn transcripts_live_under_the_encoded_project_path() {
        assert_eq!(
            transcripts_dir(Path::new("/cfg"), Path::new("/Users/me/.cadencr/wt")),
            PathBuf::from("/cfg/projects/-Users-me--cadencr-wt")
        );
    }
}
