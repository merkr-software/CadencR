//! Where this `cadencr` binary was installed from, which decides how it opens
//! the desktop app and where it finds the service it runs headless.
//!
//! - macOS app: `Cadencr.app/Contents/Resources/bin/cadencr`, linked into the
//!   PATH by the app's "Install the cadencr command" action.
//! - Linux DEB/RPM: `<app>/resources/bin/cadencr`, linked as `/usr/bin/cadencr`
//!   by the package.
//! - Linux AppImage: a copy in `~/.local/bin` whose AppImage is recorded in
//!   `<config>/cli.json` by the app, since the AppImage mount is transient.
//! - Server archive: `cadencr-server/bin/cadencr` beside `lib/server.json`,
//!   for machines without a desktop session.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::{operation_error, Diagnostic};

const MAC_EXECUTABLE: &str = "Cadencr";
const LINUX_EXECUTABLE: &str = "cadencr";
pub(super) const SERVER_MANIFEST: &str = "server.json";
const LOCATOR_FILE: &str = "cli.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Installation {
    /// A desktop app whose files are on disk: the macOS bundle or a DEB/RPM.
    App {
        executable: PathBuf,
        resources: PathBuf,
    },
    AppImage {
        appimage: PathBuf,
    },
    Server {
        root: PathBuf,
        version: String,
    },
}

#[derive(Deserialize)]
struct Locator {
    version: u32,
    appimage: PathBuf,
}

#[derive(Deserialize)]
pub(super) struct ServerManifest {
    pub(super) version: String,
    /// `linux-x64`, …: an update only installs an archive for this machine.
    pub(super) platform: Option<String>,
}

impl Installation {
    pub(super) fn detect() -> Result<Self, Diagnostic> {
        let executable = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|error| operation_error("CLI_INSTALL_NOT_FOUND", error))?;
        if let Some(installation) = from_executable(&executable)? {
            return Ok(installation);
        }
        let locator = cadencr_app_paths::config_dir()
            .map_err(|error| operation_error("CLI_INSTALL_NOT_FOUND", error))?
            .join(LOCATOR_FILE);
        if let Some(installation) = from_locator(&locator)? {
            return Ok(installation);
        }
        Err(operation_error(
            "CLI_INSTALL_NOT_FOUND",
            format!(
                "{} is not the cadencr command installed by CadencR. In CadencR, open \
                 Settings and install the cadencr command, or use the server archive.",
                executable.display()
            ),
        ))
    }
}

/// Recognizes the layouts the CLI ships in, from its own resolved path.
fn from_executable(executable: &Path) -> Result<Option<Installation>, Diagnostic> {
    let Some(bin) = executable.parent() else {
        return Ok(None);
    };
    let Some(parent) = bin.parent() else {
        return Ok(None);
    };
    let server_manifest = parent.join("lib").join(SERVER_MANIFEST);
    if server_manifest.is_file() {
        let manifest = read_server_manifest(&server_manifest)?;
        return Ok(Some(Installation::Server {
            root: parent.to_path_buf(),
            version: manifest.version,
        }));
    }
    let resources = parent;
    if resources.file_name().and_then(|name| name.to_str()) == Some("Resources") {
        let mac_executable = resources.with_file_name("MacOS").join(MAC_EXECUTABLE);
        if mac_executable.is_file() {
            return Ok(Some(Installation::App {
                executable: mac_executable,
                resources: resources.to_path_buf(),
            }));
        }
    }
    if resources.file_name().and_then(|name| name.to_str()) == Some("resources") {
        if let Some(app_dir) = resources.parent() {
            let linux_executable = app_dir.join(LINUX_EXECUTABLE);
            if linux_executable.is_file() {
                return Ok(Some(Installation::App {
                    executable: linux_executable,
                    resources: resources.to_path_buf(),
                }));
            }
        }
    }
    Ok(None)
}

fn from_locator(locator: &Path) -> Result<Option<Installation>, Diagnostic> {
    let bytes = match std::fs::read(locator) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(locator_error(locator, error)),
    };
    let locator_data: Locator =
        serde_json::from_slice(&bytes).map_err(|error| locator_error(locator, error))?;
    if locator_data.version != 1 || !locator_data.appimage.is_absolute() {
        return Err(locator_error(locator, "unsupported content"));
    }
    if !locator_data.appimage.is_file() {
        return Err(operation_error(
            "CLI_INSTALL_NOT_FOUND",
            format!(
                "the CadencR AppImage recorded in {} is gone ({}). Open CadencR and \
                 install the cadencr command again.",
                locator.display(),
                locator_data.appimage.display()
            ),
        ));
    }
    Ok(Some(Installation::AppImage {
        appimage: locator_data.appimage,
    }))
}

pub(super) fn read_server_manifest(path: &Path) -> Result<ServerManifest, Diagnostic> {
    let bytes = std::fs::read(path).map_err(|error| server_manifest_error(path, error))?;
    serde_json::from_slice(&bytes).map_err(|error| server_manifest_error(path, error))
}

fn server_manifest_error(path: &Path, error: impl std::fmt::Display) -> Diagnostic {
    operation_error(
        "CLI_INSTALL_INVALID",
        format!("cannot read {}: {error}", path.display()),
    )
}

fn locator_error(path: &Path, error: impl std::fmt::Display) -> Diagnostic {
    operation_error(
        "CLI_INSTALL_INVALID",
        format!(
            "cannot read {}: {error}. Open CadencR and install the cadencr command again.",
            path.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn recognizes_the_macos_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let contents = dir.path().join("Cadencr.app/Contents");
        touch(&contents.join("MacOS/Cadencr"));
        let cli = contents.join("Resources/bin/cadencr");
        touch(&cli);
        assert_eq!(
            from_executable(&cli).unwrap(),
            Some(Installation::App {
                executable: contents.join("MacOS/Cadencr"),
                resources: contents.join("Resources"),
            })
        );
    }

    #[test]
    fn recognizes_a_linux_package() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("opt/Cadencr");
        touch(&app.join("cadencr"));
        let cli = app.join("resources/bin/cadencr");
        touch(&cli);
        assert_eq!(
            from_executable(&cli).unwrap(),
            Some(Installation::App {
                executable: app.join("cadencr"),
                resources: app.join("resources"),
            })
        );
    }

    #[test]
    fn recognizes_a_server_archive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("cadencr-server");
        let cli = root.join("bin/cadencr");
        touch(&cli);
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(root.join("lib/server.json"), br#"{"version":"0.16.1"}"#).unwrap();
        assert_eq!(
            from_executable(&cli).unwrap(),
            Some(Installation::Server {
                root,
                version: "0.16.1".into(),
            })
        );
    }

    #[test]
    fn a_standalone_binary_is_not_an_installation() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("bin/cadencr");
        touch(&cli);
        assert_eq!(from_executable(&cli).unwrap(), None);
    }

    #[test]
    fn locator_points_at_an_existing_appimage() {
        let dir = tempfile::tempdir().unwrap();
        let locator = dir.path().join("cli.json");
        assert_eq!(from_locator(&locator).unwrap(), None);

        let appimage = dir.path().join("Cadencr.AppImage");
        touch(&appimage);
        let content = serde_json::json!({ "version": 1, "appimage": appimage });
        std::fs::write(&locator, content.to_string()).unwrap();
        assert_eq!(
            from_locator(&locator).unwrap(),
            Some(Installation::AppImage { appimage })
        );

        std::fs::write(
            &locator,
            br#"{"version":1,"appimage":"/gone/Cadencr.AppImage"}"#,
        )
        .unwrap();
        assert_eq!(
            from_locator(&locator).unwrap_err().code,
            "CLI_INSTALL_NOT_FOUND"
        );
        std::fs::write(&locator, br#"{"version":2,"appimage":"/x"}"#).unwrap();
        assert_eq!(
            from_locator(&locator).unwrap_err().code,
            "CLI_INSTALL_INVALID"
        );
    }
}
