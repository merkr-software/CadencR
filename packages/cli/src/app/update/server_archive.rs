//! Installing a server archive over a server installation.
//!
//! The archive (`cadencr-server-<version>-<platform>.tar.gz`) holds one
//! `cadencr-server/` folder. It is unpacked beside the installation and
//! checked, then swapped in with two renames; the replaced folder is kept as
//! `.<installation>.previous` until the next update.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest as _, Sha256};

use super::parse_version;
use crate::app::hex;
use crate::app::install::read_server_manifest;
use crate::{operation_error, Diagnostic};

mod transaction;

pub(super) use transaction::ServerUpdate;
use transaction::{file_error, manifest_path, swap};

const ARCHIVE_ROOT: &str = "cadencr-server";

impl ServerUpdate {
    /// `cadencr update --archive`: an archive the user downloaded themselves.
    pub(super) fn install_local(&self, archive: &Path) -> Result<String, Diagnostic> {
        let workspace = self.workspace()?;
        let outcome = self.install(workspace.path(), archive, None);
        finish(workspace, outcome)
    }

    pub(super) async fn install_remote(
        &self,
        client: &reqwest::Client,
        url: &str,
        checksum: &str,
        version: &str,
    ) -> Result<(), Diagnostic> {
        let workspace = self.workspace()?;
        let archive = workspace.path().join("archive.tar.gz");
        let outcome = async {
            download(client, url, &archive, checksum).await?;
            self.install(workspace.path(), &archive, Some(version))
                .map(drop)
        }
        .await;
        finish(workspace, outcome)
    }

    /// Unpacks, checks and swaps in `archive`; returns the installed version.
    fn install(
        &self,
        workspace: &Path,
        archive: &Path,
        expected_version: Option<&str>,
    ) -> Result<String, Diagnostic> {
        let staging = workspace.join("staging");
        unpack(archive, &staging)?;
        let replacement = staging.join(ARCHIVE_ROOT);
        let installed = check(&replacement, expected_version)?;
        swap(self, &replacement)?;
        Ok(installed)
    }
}

/// The release asset for this machine.
pub(super) fn asset_name(version: &str) -> Result<String, Diagnostic> {
    Ok(format!(
        "cadencr-server-{version}-{}.tar.gz",
        host_platform()?
    ))
}

/// This machine's platform, as server archives and their manifest name it.
fn host_platform() -> Result<&'static str, Diagnostic> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        (os, arch) => Err(operation_error(
            "CLI_UPDATE_UNAVAILABLE",
            format!("no server archive is published for {os} {arch}"),
        )),
    }
}

/// Streams the archive into the attempt's workspace and checks its SHA-256.
async fn download(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    expected_sha256: &str,
) -> Result<(), Diagnostic> {
    let failed = |error: &dyn std::fmt::Display| {
        operation_error("CLI_UPDATE_FAILED", format!("{url}: {error}"))
    };
    let response = client
        .get(url)
        .timeout(Duration::from_secs(30 * 60))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| failed(&error))?;
    let actual = save(response, path, &failed).await?;
    if actual != expected_sha256 {
        return Err(failed(&format!(
            "SHA-256 mismatch (expected {expected_sha256}, got {actual})"
        )));
    }
    Ok(())
}

/// Writes the response body to `path`; returns its SHA-256.
async fn save(
    mut response: reqwest::Response,
    path: &Path,
    failed: &impl Fn(&dyn std::fmt::Display) -> Diagnostic,
) -> Result<String, Diagnostic> {
    let mut file = std::fs::File::create(path).map_err(|error| file_error(path, error))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| failed(&error))? {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|error| file_error(path, error))?;
    }
    file.sync_all().map_err(|error| file_error(path, error))?;
    Ok(hex(&hasher.finalize()))
}

fn finish<T>(
    workspace: tempfile::TempDir,
    outcome: Result<T, Diagnostic>,
) -> Result<T, Diagnostic> {
    let path = workspace.path().to_path_buf();
    let Err(cleanup) = workspace.close() else {
        return outcome;
    };
    let cleanup = format!("Could not remove {}: {cleanup}", path.display());
    match outcome {
        Ok(_) => Err(operation_error(
            "CLI_UPDATE_FAILED",
            format!("Update applied. {cleanup}"),
        )),
        Err(mut error) => {
            error.message.push('\n');
            error.message.push_str(&cleanup);
            Err(error)
        }
    }
}

fn unpack(archive: &Path, destination: &Path) -> Result<(), Diagnostic> {
    let file = std::fs::File::open(archive).map_err(|error| file_error(archive, error))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    tar.set_preserve_permissions(true);
    tar.set_overwrite(false);
    // `unpack` refuses entries that would land outside `destination`.
    tar.unpack(destination).map_err(|error| {
        operation_error(
            "CLI_UPDATE_INVALID_ARCHIVE",
            format!("{}: {error}", archive.display()),
        )
    })
}

fn check(unpacked: &Path, expected_version: Option<&str>) -> Result<String, Diagnostic> {
    let invalid = |what: &str| {
        operation_error(
            "CLI_UPDATE_INVALID_ARCHIVE",
            format!("the archive is not a CadencR server archive ({what})"),
        )
    };
    for required in [
        "bin/cadencr",
        "lib/cadencr-service",
        "lib/renderer/index.html",
    ] {
        if !unpacked.join(required).is_file() {
            return Err(invalid(&format!("no {ARCHIVE_ROOT}/{required}")));
        }
    }
    let manifest = read_server_manifest(&manifest_path(unpacked))?;
    let host = host_platform()?;
    if manifest.platform.as_deref() != Some(host) {
        return Err(invalid(&format!(
            "it is built for {}, not {host}",
            manifest
                .platform
                .as_deref()
                .unwrap_or("an unnamed platform")
        )));
    }
    if let Some(expected) = expected_version {
        if manifest.version != expected {
            return Err(invalid(&format!(
                "it holds {} instead of {expected}",
                manifest.version
            )));
        }
    }
    // Rejects a manifest version the next update could not compare.
    parse_version(&manifest.version)?;
    Ok(manifest.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    pub(super) fn server_tree(dir: &Path, version: &str) -> PathBuf {
        let root = dir.join(ARCHIVE_ROOT);
        for file in [
            "bin/cadencr",
            "lib/cadencr-service",
            "lib/renderer/index.html",
        ] {
            std::fs::create_dir_all(root.join(file).parent().unwrap()).unwrap();
            std::fs::write(root.join(file), version).unwrap();
        }
        write_manifest(&root, version, host_platform().unwrap());
        root
    }

    fn write_manifest(root: &Path, version: &str, platform: &str) {
        std::fs::write(
            root.join("lib/server.json"),
            format!(r#"{{"version":"{version}","platform":"{platform}"}}"#),
        )
        .unwrap();
    }

    fn archive_of(tree: &Path, at: &Path) {
        let file = std::fs::File::create(at).unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::fast(),
        ));
        builder.append_dir_all(ARCHIVE_ROOT, tree).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }

    fn install(
        root: &Path,
        archive: &Path,
        expected_version: Option<&str>,
    ) -> Result<String, Diagnostic> {
        let update = ServerUpdate::begin(root)?;
        update.prepare()?;
        let workspace = update.workspace()?;
        let outcome = update.install(workspace.path(), archive, expected_version);
        finish(workspace, outcome)
    }

    #[test]
    fn an_archive_replaces_the_installation_and_keeps_the_previous_one() {
        let dir = tempfile::tempdir().unwrap();
        let installed = server_tree(&dir.path().join("installed"), "1.0.0");
        let source = server_tree(&dir.path().join("source"), "1.1.0");
        let archive = dir.path().join("server.tar.gz");
        archive_of(&source, &archive);

        assert_eq!(
            install(&installed, &archive, Some("1.1.0")).unwrap(),
            "1.1.0"
        );
        assert_eq!(
            std::fs::read_to_string(installed.join("bin/cadencr")).unwrap(),
            "1.1.0"
        );
        let previous = installed.with_file_name(format!(".{ARCHIVE_ROOT}.previous"));
        assert_eq!(
            std::fs::read_to_string(previous.join("bin/cadencr")).unwrap(),
            "1.0.0"
        );
        let backup_update = ServerUpdate::from_executable(&previous.join("bin/cadencr"))
            .unwrap()
            .unwrap();
        let error = backup_update.prepare().unwrap_err();
        assert!(error.message.contains(
            &fs::canonicalize(&installed)
                .unwrap()
                .join("bin/cadencr")
                .display()
                .to_string()
        ));
    }

    #[test]
    fn a_wrong_or_incomplete_archive_leaves_the_installation_alone() {
        let dir = tempfile::tempdir().unwrap();
        let installed = server_tree(&dir.path().join("installed"), "1.0.0");
        let source = server_tree(&dir.path().join("source"), "1.1.0");
        let archive = dir.path().join("server.tar.gz");
        archive_of(&source, &archive);

        let error = install(&installed, &archive, Some("1.2.0")).unwrap_err();
        assert_eq!(error.code, "CLI_UPDATE_INVALID_ARCHIVE");

        std::fs::remove_file(source.join("lib/cadencr-service")).unwrap();
        archive_of(&source, &archive);
        let error = install(&installed, &archive, None).unwrap_err();
        assert_eq!(error.code, "CLI_UPDATE_INVALID_ARCHIVE");
        assert_eq!(
            std::fs::read_to_string(installed.join("bin/cadencr")).unwrap(),
            "1.0.0"
        );
    }

    #[test]
    fn an_archive_for_another_platform_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let installed = server_tree(&dir.path().join("installed"), "1.0.0");
        let source = server_tree(&dir.path().join("source"), "1.1.0");
        let other = if host_platform().unwrap() == "linux-x64" {
            "linux-arm64"
        } else {
            "linux-x64"
        };
        write_manifest(&source, "1.1.0", other);
        let archive = dir.path().join("server.tar.gz");
        archive_of(&source, &archive);

        let error = install(&installed, &archive, None).unwrap_err();
        assert_eq!(error.code, "CLI_UPDATE_INVALID_ARCHIVE");
        assert!(error.message.contains(other), "{}", error.message);
    }

    #[test]
    fn asset_names_carry_the_version_and_platform() {
        let name = asset_name("1.2.3").unwrap();
        assert!(name.starts_with("cadencr-server-1.2.3-"));
        assert!(name.ends_with(".tar.gz"));
    }
}
