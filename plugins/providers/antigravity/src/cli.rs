use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cadencr_provider_sdk::ProviderError;
use tokio::process::Command;

pub const BINARY: &str = "agy";
const COMMAND_ENV: &str = "CADENCR_ANTIGRAVITY_COMMAND";
pub const SIGN_IN: &str = "Sign in with `agy acp --login` in a terminal, then retry.";

pub fn resolve() -> Result<PathBuf, ProviderError> {
    if let Some(path) = std::env::var_os(COMMAND_ENV).filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_absolute() && is_executable(&path)? {
            return Ok(path);
        }
        return Err(ProviderError::new(format!(
            "{COMMAND_ENV} must name an absolute path to an executable Antigravity CLI."
        )));
    }

    // The service inherits the user's login-shell PATH. Also check Google's
    // default installer location for GUI and standalone launches.
    if let Some(path) = cli_discovery::find_on_path(BINARY) {
        return Ok(path);
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        if let Some(path) = default_installation(&home)? {
            return Ok(path);
        }
    }
    Err(ProviderError::cli_not_found(format!(
        "Antigravity CLI (`agy`) was not found. Install it from https://antigravity.google/docs/cli/tutorial/ and add it to PATH, or set {COMMAND_ENV} to its absolute path."
    )))
}

fn default_installation(home: &Path) -> io::Result<Option<PathBuf>> {
    let path = home.join(".local/bin").join(BINARY);
    Ok((path.is_absolute() && is_executable(&path)?).then_some(path))
}

fn is_executable(path: &Path) -> io::Result<bool> {
    let metadata = match path.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    Ok(metadata.is_file())
}

pub fn command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    command.kill_on_drop(true);
    command
}

pub fn runtime() -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
}

pub const STDIN_SHUTDOWN: Duration = Duration::from_millis(100);

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn installer_fallback_requires_an_executable_file() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".local/bin").join(BINARY);
        assert_eq!(default_installation(home.path()).unwrap(), None);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "agy").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(default_installation(home.path()).unwrap(), None);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(default_installation(home.path()).unwrap(), Some(path));
    }
}
