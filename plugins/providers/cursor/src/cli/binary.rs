//! Locate the Cursor Agent CLI (`agent`).
//!
//! Cursor renamed its primary entry point from `cursor-agent` to `agent` in
//! January 2026; the official installer places it in `~/.local/bin`. Cadencr
//! hydrates the service's `PATH` from the login shell before launching
//! connectors, so the CLI is executed directly, never through a shell.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use cadencr_provider_sdk::ProviderError;

/// Absolute path override for the `agent` executable.
pub const COMMAND_ENV: &str = "CADENCR_CURSOR_COMMAND";
const BINARY_NAME: &str = "agent";
const WELL_KNOWN_DIRS: [&str; 4] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
];

pub fn resolve_binary() -> Result<PathBuf, ProviderError> {
    resolve_with(
        std::env::var_os(COMMAND_ENV).as_deref(),
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )
}

fn resolve_with(
    override_path: Option<&OsStr>,
    path: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Result<PathBuf, ProviderError> {
    if let Some(command) = override_path.filter(|value| !value.is_empty()) {
        let command = PathBuf::from(command);
        if command.is_absolute() && is_executable_file(&command) {
            return Ok(command);
        }
        return Err(ProviderError::new(format!(
            "{COMMAND_ENV} must be the absolute path of an executable Cursor Agent CLI; `{}` is not",
            command.display()
        )));
    }
    let searched = search_dirs(path, home);
    searched
        .iter()
        .map(|dir| dir.join(BINARY_NAME))
        .find(|candidate| is_executable_file(candidate))
        .ok_or_else(|| {
            ProviderError::new(format!(
                "Cursor Agent CLI (`agent`) not found; searched {} location(s). Install it with \
                 `curl https://cursor.com/install -fsS | bash` and run `agent login`, or set \
                 {COMMAND_ENV} to its absolute path.",
                searched.len()
            ))
        })
}

fn search_dirs(path: Option<&OsStr>, home: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    if let Some(home) = home.filter(|value| !value.is_empty()) {
        dirs.push(Path::new(home).join(".local/bin"));
    }
    dirs.extend(WELL_KNOWN_DIRS.iter().map(PathBuf::from));
    let mut unique = Vec::with_capacity(dirs.len());
    for dir in dirs {
        if dir.is_absolute() && !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Display name used in diagnostics (`agent update`, `agent models`).
pub fn command_label(binary: &Path, args: &[OsString]) -> String {
    let name = binary
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let args = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    format!("{name} {args}").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{command_label, resolve_with};
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    fn executable(dir: &Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\necho 2026.03.11-6dfa30c\n").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[test]
    fn override_must_be_an_absolute_executable() {
        let dir = tempfile::tempdir().unwrap();
        let binary = executable(dir.path(), "cursor-agent");
        assert_eq!(
            resolve_with(Some(binary.as_os_str()), None, None).unwrap(),
            binary
        );
        let error = resolve_with(Some("agent".as_ref()), None, None).unwrap_err();
        assert!(error.to_string().contains("CADENCR_CURSOR_COMMAND"));
        let missing = dir.path().join("missing");
        assert!(resolve_with(Some(missing.as_os_str()), None, None).is_err());
    }

    #[test]
    fn searches_path_then_the_installer_location() {
        let path_dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".local/bin")).unwrap();
        let installed = executable(&home.path().join(".local/bin"), "agent");
        assert_eq!(
            resolve_with(
                None,
                Some(path_dir.path().as_os_str()),
                Some(home.path().as_os_str())
            )
            .unwrap(),
            installed
        );
        let on_path = executable(path_dir.path(), "agent");
        assert_eq!(
            resolve_with(
                None,
                Some(path_dir.path().as_os_str()),
                Some(home.path().as_os_str())
            )
            .unwrap(),
            on_path
        );
    }

    #[test]
    fn missing_cli_error_is_actionable() {
        let empty = tempfile::tempdir().unwrap();
        let result = resolve_with(
            None,
            Some(empty.path().as_os_str()),
            Some(empty.path().as_os_str()),
        );
        if let Err(error) = result {
            let message = error.to_string();
            assert!(message.contains("cursor.com/install"), "{message}");
            assert!(message.contains("agent login"), "{message}");
        }
    }

    #[test]
    fn labels_commands_by_file_name() {
        assert_eq!(
            command_label(Path::new("/x/agent"), &[OsString::from("update")]),
            "agent update"
        );
    }
}
