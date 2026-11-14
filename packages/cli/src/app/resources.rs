//! The files `cadencr serve` runs: the service binary and the built interface
//! it serves to remote devices, from whichever installation this CLI belongs to.

use std::io::BufRead as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use super::install::Installation;
use crate::{operation_error, Diagnostic};

const SERVICE_BINARY: &str = "cadencr-service";
const RENDERER_DIR: &str = "renderer";

pub(super) struct ServiceResources {
    pub(super) service: PathBuf,
    pub(super) renderer: PathBuf,
    pub(super) app_version: Option<String>,
    /// Keeps an AppImage mounted while the service runs from it.
    _mount: Option<AppImageMount>,
}

impl ServiceResources {
    pub(super) fn locate(installation: Installation) -> Result<Self, Diagnostic> {
        let (resources, app_version, mount) = match installation {
            Installation::App { resources, .. } => (resources, bundled_app_version(), None),
            Installation::Server { root, version } => (root.join("lib"), Some(version), None),
            Installation::AppImage { appimage } => {
                let mount = AppImageMount::mount(&appimage)?;
                (mount.resources(), bundled_app_version(), Some(mount))
            }
        };
        let located = Self {
            service: resources.join(SERVICE_BINARY),
            renderer: resources.join(RENDERER_DIR),
            app_version,
            _mount: mount,
        };
        located.verify()?;
        Ok(located)
    }

    fn verify(&self) -> Result<(), Diagnostic> {
        if !self.service.is_file() {
            return Err(missing(&self.service));
        }
        if !self.renderer.join("index.html").is_file() {
            return Err(missing(&self.renderer.join("index.html")));
        }
        Ok(())
    }
}

/// The app version the packaging step built this CLI for (empty outside a
/// packaged build): the service names its pre-migration backups after it, and
/// `update --check` compares it with the latest release.
pub(super) fn bundled_app_version() -> Option<String> {
    let version = env!("CADENCR_BUNDLED_APP_VERSION");
    (!version.is_empty()).then(|| version.to_string())
}

fn missing(path: &Path) -> Diagnostic {
    operation_error(
        "CLI_INSTALL_INVALID",
        format!(
            "{} is missing; reinstall CadencR or the server archive",
            path.display()
        ),
    )
}

/// `<AppImage> --appimage-mount` prints its mount point and keeps it mounted
/// until stopped.
struct AppImageMount {
    child: Child,
    mount_point: PathBuf,
}

impl AppImageMount {
    fn mount(appimage: &Path) -> Result<Self, Diagnostic> {
        use std::os::unix::process::CommandExt as _;

        let mut command = Command::new(appimage);
        command
            .arg("--appimage-mount")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            // Stopped by this CLI after the service, not by the terminal's Ctrl+C.
            .process_group(0);
        stop_with_parent(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| mount_error(appimage, error))?;
        let mut line = String::new();
        let read = child
            .stdout
            .take()
            .map(|stdout| std::io::BufReader::new(stdout).read_line(&mut line));
        let mount_point = PathBuf::from(line.trim_end());
        if !matches!(read, Some(Ok(count)) if count > 0) || !mount_point.is_dir() {
            stop(&mut child);
            return Err(mount_error(appimage, "no mount point was reported"));
        }
        Ok(Self { child, mount_point })
    }

    fn resources(&self) -> PathBuf {
        self.mount_point.join("resources")
    }
}

impl Drop for AppImageMount {
    fn drop(&mut self) {
        stop(&mut self.child);
    }
}

/// The mount must not outlive this CLI when it dies without unwinding (SIGKILL,
/// a crash): its own process group shields it from the terminal's signals.
#[cfg(target_os = "linux")]
fn stop_with_parent(command: &mut Command) {
    use std::os::unix::process::CommandExt as _;

    // SAFETY: prctl is async-signal-safe and touches only the child.
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

/// AppImages only exist on Linux.
#[cfg(not(target_os = "linux"))]
fn stop_with_parent(_command: &mut Command) {}

fn stop(child: &mut Child) {
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: signals our own child, which unmounts on SIGTERM.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    if let Err(error) = child.wait() {
        eprintln!("warning: could not wait for the AppImage mount to stop: {error}");
    }
}

fn mount_error(appimage: &Path, error: impl std::fmt::Display) -> Diagnostic {
    operation_error(
        "CLI_APPIMAGE_MOUNT_FAILED",
        format!("cannot mount {}: {error}", appimage.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_archive_provides_its_service_and_interface() {
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("lib");
        std::fs::create_dir_all(lib.join("renderer")).unwrap();
        std::fs::write(lib.join("cadencr-service"), b"").unwrap();

        let installation = Installation::Server {
            root: dir.path().to_path_buf(),
            version: "1.2.3".into(),
        };
        assert_eq!(
            ServiceResources::locate(installation.clone())
                .err()
                .unwrap()
                .code,
            "CLI_INSTALL_INVALID"
        );

        std::fs::write(lib.join("renderer/index.html"), b"").unwrap();
        let located = ServiceResources::locate(installation).unwrap();
        assert_eq!(located.service, lib.join("cadencr-service"));
        assert_eq!(located.renderer, lib.join("renderer"));
        assert_eq!(located.app_version.as_deref(), Some("1.2.3"));
    }
}
