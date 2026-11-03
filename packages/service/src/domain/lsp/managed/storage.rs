//! Immutable revisions retain lazy JS dependencies for existing sessions after update/removal.
mod payload;
use super::super::{
    catalog::ServerRole,
    probe::{LspLanguage, ServerProbe, ServerProbeStatus},
};
use super::{invalid, platform};
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::domain::themes::managed::{catalog, models::SignedMixedCatalog, storage as io};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub index: SignedMixedCatalog,
    pub id: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pointer {
    pub version: String,
    pub sha256: String,
}
pub fn root() -> Result<PathBuf, AppError> {
    Ok(crate::shared::app_paths::data_dir()
        .map_err(invalid)?
        .join("lsp-marketplace"))
}
pub fn secure(root: &Path) -> Result<(), AppError> {
    io::with_root(root.to_path_buf(), || io::secure(root))
}
pub fn owner(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    if !cadencr_registry_core::valid_theme_id(id) {
        return Err(invalid("invalid LSP id"));
    }
    Ok(root.join(id))
}
pub fn revision(root: &Path, id: &str, pointer: &Pointer) -> Result<PathBuf, AppError> {
    if semver::Version::parse(&pointer.version).is_err()
        || pointer.version.contains(['/', '\\'])
        || pointer.sha256.len() != 64
        || !pointer
            .sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid("invalid LSP revision"));
    }
    Ok(owner(root, id)?
        .join(&pointer.version)
        .join(&pointer.sha256))
}
pub fn pointer(root: &Path, id: &str) -> Result<Pointer, AppError> {
    let owner = owner(root, id)?;
    io::with_root(root.to_path_buf(), || {
        io::secure(&owner)?;
        io::bounded_json(&owner.join("active.json"))
    })
}
pub fn activate(root: &Path, id: &str, pointer: &Pointer) -> Result<(), AppError> {
    let owner = owner(root, id)?;
    io::with_root(root.to_path_buf(), || io::secure(&owner))?;
    crate::shared::atomic_file::write_atomic_private(
        &owner.join("active.json"),
        &serde_json::to_string(pointer).map_err(invalid)?,
    )
}
pub fn ids(root: &Path) -> Result<Vec<String>, AppError> {
    if !root.try_exists().map_err(invalid)? {
        return Ok(vec![]);
    }
    secure(root)?;
    let mut ids = vec![];
    for entry in std::fs::read_dir(root).map_err(invalid)? {
        let entry = entry.map_err(invalid)?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if cadencr_registry_core::valid_theme_id(&id)
            && entry.path().join("active.json").symlink_metadata().is_ok()
        {
            ids.push(id);
        }
    }
    Ok(ids)
}
pub fn read(
    root: &Path,
    id: &str,
) -> Result<(ServerProbe, cadencr_registry_core::LspTarget), AppError> {
    let active = pointer(root, id)?;
    read_revision(root, id, &active)
}
pub fn read_revision(
    root: &Path,
    id: &str,
    active: &Pointer,
) -> Result<(ServerProbe, cadencr_registry_core::LspTarget), AppError> {
    read_revision_trusted(root, id, active, &pinned_index_trust_store())
}
pub(in crate::domain::lsp) fn read_revision_trusted(
    root: &Path,
    id: &str,
    active: &Pointer,
    trust: &ManagedTrustStore,
) -> Result<(ServerProbe, cadencr_registry_core::LspTarget), AppError> {
    let dir = revision(root, id, active)?;
    let (probe, target) = inspect_revision(root, id, active, trust)?;
    let bytes = io::regular(&dir.join("archive.tar.gz"), target.size as usize)?;
    let files =
        cadencr_registry_core::read_lsp_archive(&bytes, platform(), &target).map_err(invalid)?;
    payload::verify(root, &dir, files)?;
    Ok((probe, target))
}
/// Inventory authenticates only the bounded signed receipt; launch verifies every payload byte.
fn inspect_revision(
    root: &Path,
    id: &str,
    active: &Pointer,
    trust: &ManagedTrustStore,
) -> Result<(ServerProbe, cadencr_registry_core::LspTarget), AppError> {
    let dir = revision(root, id, active)?;
    let receipt: Receipt = io::with_root(root.to_path_buf(), || {
        io::secure(&dir)?;
        let bytes = io::regular(
            &dir.join("receipt.json"),
            cadencr_registry_core::MAX_CATALOG_BYTES + 64 * 1024,
        )?;
        serde_json::from_slice(&bytes).map_err(invalid)
    })?;
    if receipt.id != id || receipt.version != active.version {
        return Err(invalid("LSP receipt identity mismatch"));
    }
    catalog::verify(&receipt.index, trust, true)?;
    let package = catalog::resolve_kind(&receipt.index, id, &active.version, "lsp")?;
    let target = cadencr_registry_core::signed_lsp_target(&package, platform()).map_err(invalid)?;
    if active.sha256 != target.sha256 {
        return Err(invalid("LSP archive pointer mismatch"));
    }
    super::policy::require(id, &active.version, &target)?;
    let mut probe = probe(&package, ServerProbeStatus::Managed)?;
    probe.path = Some(
        dir.join("payload")
            .join(&target.entry)
            .to_string_lossy()
            .into_owned(),
    );
    Ok((probe, target))
}
pub fn probe(
    package: &serde_json::Value,
    status: ServerProbeStatus,
) -> Result<ServerProbe, AppError> {
    let manifest = &package["lsp"];
    let text = |key| {
        manifest[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid(format!("LSP {key} missing")))
    };
    let languages: Vec<LspLanguage> =
        serde_json::from_value(manifest["languages"].clone()).map_err(invalid)?;
    let role: ServerRole = serde_json::from_value(manifest["role"].clone()).map_err(invalid)?;
    Ok(ServerProbe {
        lsp_id: text("id")?,
        name: text("name")?,
        description: text("description")?,
        bin_name: text("id")?,
        args: serde_json::from_value(manifest["args"].clone()).map_err(invalid)?,
        language_ids: languages
            .iter()
            .map(|language| language.id.clone())
            .collect(),
        languages,
        root_markers: serde_json::from_value(manifest["root_markers"].clone()).map_err(invalid)?,
        role,
        status,
        path: None,
        version: Some(text("version")?),
        downloadable: false,
        initialization_options: manifest["initialization_options"].clone(),
        error: None,
    })
}
pub fn inventory(root: &Path) -> Result<Vec<ServerProbe>, AppError> {
    inventory_trusted(root, &pinned_index_trust_store())
}
pub(super) fn inventory_trusted(
    root: &Path,
    trust: &ManagedTrustStore,
) -> Result<Vec<ServerProbe>, AppError> {
    ids(root)?
        .into_iter()
        .map(|id| {
            match pointer(root, &id)
                .and_then(|pointer| inspect_revision(root, &id, &pointer, trust))
            {
                Ok((probe, _)) => Ok(probe),
                Err(error) => Ok(ServerProbe {
                    lsp_id: id.clone(),
                    name: id.clone(),
                    description: String::new(),
                    bin_name: id,
                    args: vec![],
                    language_ids: vec![],
                    languages: vec![],
                    root_markers: vec![],
                    role: ServerRole::General,
                    status: ServerProbeStatus::Invalid,
                    path: None,
                    version: None,
                    downloadable: false,
                    initialization_options: serde_json::json!({}),
                    error: Some(error.to_string()),
                }),
            }
        })
        .collect()
}
pub fn removed(root: &Path, id: &str) -> bool {
    owner(root, id).is_ok_and(|owner| owner.join("removed.json").is_file())
}

/// LSP bundles have their own 64 MiB transport budget, independent of theme archives.
pub fn write_archive(directory: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write as _;
    if bytes.len() as u64 > cadencr_registry_core::MAX_LSP_ARCHIVE_BYTES {
        return Err(invalid("LSP archive exceeds byte budget"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(directory.join("archive.tar.gz"))
        .map_err(invalid)?;
    file.write_all(bytes).map_err(invalid)?;
    file.sync_all().map_err(invalid)
}

pub fn receipt_digest(root: &Path, id: &str, pointer: &Pointer) -> Result<String, AppError> {
    let directory = revision(root, id, pointer)?;
    io::with_root(root.to_path_buf(), || {
        io::secure(&directory)?;
        io::regular(
            &directory.join("receipt.json"),
            cadencr_registry_core::MAX_CATALOG_BYTES + 64 * 1024,
        )
        .map(|bytes| io::digest(&bytes))
    })
}
