//! Hands a request to the desktop app on its command line.
//!
//! The app is started as a new process with `--cadencr-request=<JSON>`. When
//! CadencR is already running, that process forwards its arguments to the
//! running instance (Electron's single-instance lock) and exits; otherwise it
//! becomes the app and handles the request once its window is ready. Either
//! way the CLI returns at once: the app reports the outcome in its window.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use super::connection::Connection;
use super::install::Installation;
use super::usage;
use crate::{operation_error, Diagnostic};

const REQUEST_FLAG: &str = "--cadencr-request=";
const REQUEST_VERSION: u32 = 1;

pub(super) fn open(path: Option<&Path>, line: Option<u32>) -> Result<Option<String>, Diagnostic> {
    let request = match path {
        None => {
            if line.is_some() {
                return Err(usage("--line needs a file to open"));
            }
            json!({ "version": REQUEST_VERSION, "action": "focus" })
        }
        Some(path) => {
            let path = canonical(path)?;
            if line.is_some() && !path.is_file() {
                return Err(usage("--line only applies to a file"));
            }
            let mut request = json!({ "version": REQUEST_VERSION, "action": "open", "path": path });
            if let Some(line) = line {
                request["line"] = json!(line);
            }
            request
        }
    };
    send(&request)?;
    Ok(Some(match path {
        None => "Opening CadencR.".to_string(),
        Some(path) => format!("Opening {} in CadencR.", path.display()),
    }))
}

/// Asks the app to add `path` (already canonical) as a project and open it.
pub(super) fn add(path: &Path) -> Result<(), Diagnostic> {
    send(&json!({ "version": REQUEST_VERSION, "action": "add", "path": path }))
}

/// Asks the app to check for an update; its update banner takes it from there.
pub(super) fn update() -> Result<(), Diagnostic> {
    send(&json!({ "version": REQUEST_VERSION, "action": "update" }))
}

pub(super) fn canonical(path: &Path) -> Result<std::path::PathBuf, Diagnostic> {
    std::fs::canonicalize(path).map_err(|error| {
        operation_error(
            "CLI_PATH_NOT_FOUND",
            format!("cannot open {}: {error}", path.display()),
        )
    })
}

fn send(request: &Value) -> Result<(), Diagnostic> {
    Connection::refuse_running(
        "The desktop app cannot start beside it: stop it first, or connect from a paired device.",
    )?;
    let executable = match Installation::detect()? {
        Installation::App { executable, .. } => executable,
        Installation::AppImage { appimage } => appimage,
        Installation::Server { .. } => {
            return Err(operation_error(
                "CLI_NO_DESKTOP_APP",
                "this server installation has no desktop app. Run `cadencr serve` and \
                 connect from a paired device.",
            ))
        }
    };
    require_graphical_session()?;
    spawn_detached(&executable, &format!("{REQUEST_FLAG}{request}"))
}

fn spawn_detached(executable: &Path, argument: &str) -> Result<(), Diagnostic> {
    use std::os::unix::process::CommandExt as _;

    Command::new(executable)
        .arg(argument)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group: closing the terminal or Ctrl+C must not take
        // the app down with the shell.
        .process_group(0)
        .spawn()
        .map(drop)
        .map_err(|error| {
            operation_error(
                "CLI_APP_LAUNCH_FAILED",
                format!("cannot start {}: {error}", executable.display()),
            )
        })
}

/// A desktop app needs a display; without one, Linux would only fail silently
/// in the detached process.
fn require_graphical_session() -> Result<(), Diagnostic> {
    if cfg!(target_os = "macos") || has_display(|name| std::env::var_os(name)) {
        return Ok(());
    }
    Err(operation_error(
        "CLI_NO_DISPLAY",
        "no graphical session (DISPLAY and WAYLAND_DISPLAY are unset), so the desktop \
         app cannot open. Use `cadencr serve` to run CadencR headless.",
    ))
}

fn has_display(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|name| var(name).is_some_and(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_display_or_wayland_socket_counts_as_a_graphical_session() {
        assert!(has_display(|name| (name == "DISPLAY").then(|| ":0".into())));
        assert!(has_display(
            |name| (name == "WAYLAND_DISPLAY").then(|| "wayland-0".into())
        ));
        assert!(!has_display(|name| (name == "DISPLAY").then(|| "".into())));
        assert!(!has_display(|_| None));
    }

    #[test]
    fn line_requires_a_file() {
        assert_eq!(open(None, Some(3)).unwrap_err().code, "CLI_USAGE_ERROR");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            open(Some(dir.path()), Some(3)).unwrap_err().code,
            "CLI_USAGE_ERROR"
        );
    }
}
