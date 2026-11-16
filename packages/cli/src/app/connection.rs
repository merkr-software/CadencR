//! The connection file of a running `cadencr serve`: `<data>/run/serve.json`.
//!
//! It holds the loopback port and the token this CLI minted for the service, so
//! a later `cadencr pair` or `cadencr add` can call it. The file is private to
//! the user (0600 in a 0700 directory), like the database it unlocks, and is
//! removed when `serve` stops. A file whose process is gone, or whose port no
//! longer answers (a crash, then the pid reused), is stale.

use std::io::Write as _;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{operation_error, Diagnostic};

const FILE_NAME: &str = "serve.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Connection {
    pub(super) version: u32,
    /// The service process.
    pub(super) pid: u32,
    pub(super) port: u16,
    pub(super) token: String,
}

impl Connection {
    pub(super) fn new(pid: u32, port: u16, token: String) -> Self {
        Self {
            version: 1,
            pid,
            port,
            token,
        }
    }

    /// The running headless service, if any. Removes a stale file.
    pub(super) fn running() -> Result<Option<Self>, Diagnostic> {
        read_live(&path()?)
    }

    /// Fails while a headless service runs; `hint` says what to do instead.
    pub(super) fn refuse_running(hint: &str) -> Result<(), Diagnostic> {
        match Self::running()? {
            None => Ok(()),
            Some(running) => Err(operation_error(
                "CLI_HEADLESS_RUNNING",
                format!(
                    "CadencR is running headless (cadencr serve, process {}). {hint}",
                    running.pid
                ),
            )),
        }
    }

    /// The running headless service, or an error telling how to start one.
    pub(super) fn require() -> Result<Self, Diagnostic> {
        Self::running()?.ok_or_else(|| {
            operation_error(
                "CLI_HEADLESS_NOT_RUNNING",
                "CadencR is not running headless. Start it with `cadencr serve`.",
            )
        })
    }

    pub(super) fn write(&self) -> Result<PathBuf, Diagnostic> {
        let path = path()?;
        write_private(&path, self)?;
        Ok(path)
    }

    pub(super) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub(super) fn remove(path: &Path) -> Result<(), Diagnostic> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(file_error(path, error)),
    }
}

fn path() -> Result<PathBuf, Diagnostic> {
    cadencr_app_paths::run_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|error| operation_error("CLI_PATHS_UNAVAILABLE", error))
}

fn read_live(path: &Path) -> Result<Option<Connection>, Diagnostic> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(file_error(path, error)),
    };
    let connection: Connection =
        serde_json::from_slice(&bytes).map_err(|error| file_error(path, error))?;
    if connection.version != 1 {
        return Err(file_error(path, "unsupported version"));
    }
    if process_alive(connection.pid) && port_open(connection.port) {
        return Ok(Some(connection));
    }
    remove(path)?;
    Ok(None)
}

fn write_private(path: &Path, connection: &Connection) -> Result<(), Diagnostic> {
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|error| file_error(dir, error))?;
    }
    let content = serde_json::to_vec(connection).map_err(|error| file_error(path, error))?;
    remove(path)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| file_error(path, error))?;
    file.write_all(&content)
        .and_then(|()| file.sync_all())
        .map_err(|error| file_error(path, error))
}

fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 checks existence; EPERM means it exists under another user.
    // SAFETY: kill with signal 0 sends nothing.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn port_open(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, std::time::Duration::from_secs(1)).is_ok()
}

fn file_error(path: &Path, error: impl std::fmt::Display) -> Diagnostic {
    operation_error(
        "CLI_CONNECTION_FILE",
        format!("{}: {error}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn a_live_connection_round_trips_privately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run").join(FILE_NAME);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let connection = Connection::new(std::process::id(), port, "secret".into());
        write_private(&path, &connection).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(read_live(&path).unwrap(), Some(connection));
    }

    #[test]
    fn a_stale_connection_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        write_private(&path, &Connection::new(pid, 5004, "t".into())).unwrap();

        assert_eq!(read_live(&path).unwrap(), None);
        assert!(!path.exists());
    }

    #[test]
    fn a_live_pid_without_its_port_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        write_private(
            &path,
            &Connection::new(std::process::id(), port, "t".into()),
        )
        .unwrap();

        assert_eq!(read_live(&path).unwrap(), None);
        assert!(!path.exists());
    }

    #[test]
    fn a_missing_file_means_not_running() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_live(&dir.path().join(FILE_NAME)).unwrap(), None);
    }
}
