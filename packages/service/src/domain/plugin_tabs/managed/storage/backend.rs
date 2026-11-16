//! A marketplace tab's native backend inside one revision: the signed archive
//! it came from (`backend.tar.gz`, beside `archive.tar.gz`) and the one
//! executable for the platform it was installed on, at `<id>/<cmd>`. Other
//! platforms' binaries are never downloaded.
use super::filesystem::{hash_private_file, open_private_file, write_executable};
use super::{invalid, io, Receipt};
use crate::error::AppError;
use cadencr_plugin_core::tab::TabPlatform;
use cadencr_registry_core::{
    SignedTabBackend, SignedTabBinary, MAX_TAB_BACKEND_ARCHIVE_BYTES,
    MAX_TAB_BACKEND_EXECUTABLE_BYTES,
};
use std::path::Path;

pub(super) const ARCHIVE: &str = "backend.tar.gz";

/// What an installed revision's backend is, from its signed package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledBackend {
    pub platform: TabPlatform,
    pub protocol: u32,
    /// The executable's path inside the tab folder.
    pub cmd: String,
    /// The signed digest the executable is checked against before each launch.
    pub executable_sha256: String,
    pub archive_sha256: String,
}

/// The verified bytes of one platform's backend, ready to store, with the
/// signed digests they were checked against.
pub struct BackendPayload<'a> {
    pub archive: &'a [u8],
    pub archive_sha256: String,
    pub executable: &'a [u8],
    pub executable_sha256: String,
    pub cmd: &'a str,
}

/// The revision directory name: the web archive's digest for a UI-only tab
/// (unchanged from before backends), else a digest binding both archives, so
/// a new binary under an unchanged web archive is a new revision.
pub fn revision_id(archive_sha256: &str, backend_archive_sha256: Option<&str>) -> String {
    match backend_archive_sha256 {
        None => archive_sha256.to_owned(),
        Some(backend) => {
            io::digest(format!("cadencr-tab-revision\n{archive_sha256}\n{backend}\n").as_bytes())
        }
    }
}

/// The signed entry of the platform `receipt` was installed for.
pub(super) fn signed_target<'a>(
    receipt: &Receipt,
    signed: &'a SignedTabBackend,
) -> Result<(TabPlatform, &'a SignedTabBinary), AppError> {
    let platform = receipt
        .platform
        .ok_or_else(|| invalid("tab receipt does not name its backend platform"))?;
    let target = signed
        .target(platform)
        .ok_or_else(|| invalid("signed tab package has no backend for its receipt platform"))?;
    Ok((platform, target))
}

/// The backend of an installed revision, after checking its stored archive
/// against the signed digest and its executable's shape (a private, regular,
/// executable file). The executable's bytes are re-checked against
/// `executable_sha256` where they matter, right before each launch
/// (`PLUGIN_BACKEND_TAMPERED`): a tampered binary is reported where it would
/// run instead of hiding the whole tab.
pub(super) fn verify_installed(
    revision: &Path,
    payload: &Path,
    receipt: &Receipt,
    signed: Option<&SignedTabBackend>,
) -> Result<Option<InstalledBackend>, AppError> {
    let Some(signed) = signed else {
        if receipt.platform.is_some() {
            return Err(invalid("tab receipt names a backend the package lacks"));
        }
        return Ok(None);
    };
    let (platform, target) = signed_target(receipt, signed)?;
    let (sha, size) = hash_private_file(
        &revision.join(ARCHIVE),
        MAX_TAB_BACKEND_ARCHIVE_BYTES,
        false,
    )?;
    if sha != target.sha256 || size != target.size {
        return Err(invalid("tab backend archive checksum mismatch"));
    }
    open_private_file(
        &payload.join(&target.cmd),
        MAX_TAB_BACKEND_EXECUTABLE_BYTES,
        true,
    )?;
    Ok(Some(InstalledBackend {
        platform,
        protocol: signed.protocol,
        cmd: target.cmd.clone(),
        executable_sha256: target.executable_sha256.clone(),
        archive_sha256: target.sha256.clone(),
    }))
}

/// Write the backend into a staging revision whose payload folder exists.
pub(super) fn write(
    root: &Path,
    staging: &Path,
    payload: &Path,
    backend: &BackendPayload<'_>,
) -> Result<(), AppError> {
    super::write_file(&staging.join(ARCHIVE), backend.archive)?;
    let path = payload.join(backend.cmd);
    super::secure(
        root,
        path.parent()
            .ok_or_else(|| invalid("backend parent missing"))?,
    )?;
    write_executable(&path, backend.executable)
}

/// A retained revision holds exactly `backend`'s bytes.
pub(super) fn matches(
    revision: &Path,
    payload: &Path,
    backend: &BackendPayload<'_>,
) -> Result<(), AppError> {
    let archive = hash_private_file(
        &revision.join(ARCHIVE),
        MAX_TAB_BACKEND_ARCHIVE_BYTES,
        false,
    )?;
    let executable = hash_private_file(
        &payload.join(backend.cmd),
        MAX_TAB_BACKEND_EXECUTABLE_BYTES,
        true,
    )?;
    if archive != (backend.archive_sha256.clone(), backend.archive.len() as u64)
        || executable
            != (
                backend.executable_sha256.clone(),
                backend.executable.len() as u64,
            )
    {
        return Err(invalid(
            "retained tab backend differs from requested revision",
        ));
    }
    Ok(())
}
