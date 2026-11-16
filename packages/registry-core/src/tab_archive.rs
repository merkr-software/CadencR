//! A tab distribution contains its manifest, optional icon and compiled web root.
use crate::gzip::{gunzip_bounded, GunzipError};
use crate::{archive, RegistryError};
use cadencr_plugin_core::tab::{is_clean_relative_path, validate_manifest, TabManifest};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub const MAX_TAB_BYTES: u64 = 32 * 1024 * 1024;
#[derive(bon::Builder)]
pub struct PackTabRequest<'a> {
    pub directory: &'a Path,
    pub output: &'a Path,
    /// Optional full schema-2 metadata, bound to the compiled runtime manifest.
    pub package: Option<&'a Path>,
}
#[derive(Debug)]
pub struct PackedTab {
    pub archive: PathBuf,
    pub sha256: String,
    pub size: u64,
}

pub fn pack_tab(request: PackTabRequest<'_>) -> Result<PackedTab, RegistryError> {
    archive::validate_output_name(request.output)?;
    let snapshot = archive::scan::collect(request.directory)?;
    let mut files = BTreeMap::new();
    let mut remaining = MAX_TAB_BYTES;
    for entry in snapshot.entries.iter().filter(|entry| !entry.directory) {
        if entry.identity.len > remaining {
            return Err(invalid("tab payload exceeds 32 MiB"));
        }
        let name = entry
            .relative
            .to_str()
            .ok_or_else(|| invalid("non UTF-8 tab path"))?;
        let bytes = crate::safe_io::read_bounded_regular(&entry.canonical, remaining)
            .map_err(|e| invalid(e.to_string()))?;
        remaining -= bytes.len() as u64;
        files.insert(name.to_owned(), bytes);
    }
    if let Some(path) = request.package {
        let bytes = crate::safe_io::read_bounded_regular(path, 1024 * 1024)
            .map_err(|e| invalid(e.to_string()))?;
        let package = crate::parse_json_bytes(&bytes).map_err(|e| invalid(e.to_string()))?;
        crate::validate_marketplace_package(&package)?;
        if crate::marketplace_package_kind(&package) != Some("tab") {
            return Err(invalid("tab packaging requires kind: tab metadata"));
        }
        validate_tab_package_files(&package["package"], &files)?;
    } else {
        validate_tab_files(&files)?;
    }
    let built = archive::write::web_archive(&snapshot, request.output)?;
    Ok(PackedTab {
        archive: request.output.into(),
        sha256: built.sha256,
        size: built.size,
    })
}

/// Snapshot only the compiled web root and the declared manifest/icon, never author sources.
pub fn snapshot_tab_folder(directory: &Path) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    let root = directory
        .canonicalize()
        .map_err(|e| invalid(e.to_string()))?;
    let read = |name: &str, limit: u64| {
        let path = root.join(name);
        let canonical = path.canonicalize().map_err(|e| invalid(e.to_string()))?;
        if !canonical.starts_with(&root) {
            return Err(invalid("tab file escapes author folder"));
        }
        crate::safe_io::read_bounded_regular(&path, limit).map_err(|e| invalid(e.to_string()))
    };
    let (manifest, manifest_bytes) = read_folder_manifest(&root)?;
    let (web_root, _) = manifest
        .entry
        .rsplit_once('/')
        .ok_or_else(|| invalid("distributed entry requires a compiled web directory"))?;
    let snapshot = archive::scan::collect(&root.join(web_root))?;
    let mut remaining = MAX_TAB_BYTES - manifest_bytes.len() as u64;
    let mut files = BTreeMap::from([("tab.json".to_owned(), manifest_bytes)]);
    for entry in snapshot.entries.iter().filter(|entry| !entry.directory) {
        let name = format!(
            "{web_root}/{}",
            entry
                .relative
                .to_str()
                .ok_or_else(|| invalid("invalid tab asset path"))?
        );
        if entry.identity.len > remaining {
            return Err(invalid("compiled tab exceeds 32 MiB"));
        }
        let bytes = read(&name, remaining)?;
        remaining -= bytes.len() as u64;
        files.insert(name, bytes);
    }
    if let Some(icon) = &manifest.icon {
        if !files.contains_key(icon) {
            files.insert(
                icon.clone(),
                read(
                    icon,
                    remaining.min(cadencr_plugin_core::tab::MAX_ICON_BYTES),
                )?,
            );
        }
    }
    validate_tab_files(&files)?;
    Ok(files)
}

/// The valid `tab.json` of the canonical tab folder `root`, and its bytes.
pub(crate) fn read_folder_manifest(root: &Path) -> Result<(TabManifest, Vec<u8>), RegistryError> {
    let path = root.join(cadencr_plugin_core::tab::MANIFEST_FILE_NAME);
    let bytes =
        crate::safe_io::read_bounded_regular(&path, cadencr_plugin_core::tab::MAX_MANIFEST_BYTES)
            .map_err(|e| invalid(format!("cannot read tab.json: {e}")))?;
    let manifest: TabManifest = serde_json::from_value(
        crate::parse_json_bytes(&bytes).map_err(|e| invalid(e.to_string()))?,
    )
    .map_err(|e| invalid(e.to_string()))?;
    let findings = validate_manifest(&manifest);
    if !findings.is_valid() {
        return Err(invalid(findings.describe_errors()));
    }
    Ok((manifest, bytes))
}

pub fn verify_tab_archive(path: &Path) -> Result<(), RegistryError> {
    let bytes = crate::safe_io::read_bounded_regular(path, MAX_TAB_BYTES)
        .map_err(|e| invalid(e.to_string()))?;
    read_tab_archive_bytes(&bytes).map(|_| ())
}

pub fn read_tab_archive_bytes(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    if bytes.len() as u64 > MAX_TAB_BYTES {
        return Err(invalid("tab archive exceeds 32 MiB"));
    }
    let decoded = gunzip_bounded(bytes, MAX_TAB_BYTES).map_err(|error| match error {
        GunzipError::Invalid(e) => invalid(e.to_string()),
        GunzipError::OversizedOrTrailing => invalid("invalid or oversized tab gzip"),
    })?;
    let files = crate::theme_verify::read_tar(&decoded, 4096, true)?;
    validate_tab_files(&files)?;
    Ok(files)
}

pub fn validate_tab_files(files: &BTreeMap<String, Vec<u8>>) -> Result<TabManifest, RegistryError> {
    let bytes = files
        .get("tab.json")
        .ok_or_else(|| invalid("tab.json is missing"))?;
    if bytes.len() as u64 > cadencr_plugin_core::tab::MAX_MANIFEST_BYTES {
        return Err(invalid("tab.json exceeds 64 KiB"));
    }
    let manifest: TabManifest =
        serde_json::from_value(crate::parse_json_bytes(bytes).map_err(|e| invalid(e.to_string()))?)
            .map_err(|e| invalid(e.to_string()))?;
    let findings = validate_manifest(&manifest);
    if !findings.is_valid() {
        return Err(invalid(findings.describe_errors()));
    }
    let (web_root, _) = manifest
        .entry
        .rsplit_once('/')
        .ok_or_else(|| invalid("distributed tab entry must be inside a compiled web directory"))?;
    let prefix = format!("{web_root}/");
    if !files.contains_key(&manifest.entry) {
        return Err(invalid("compiled tab entry is missing"));
    }
    let mut size = 0usize;
    let mut archive_size = 1024usize;
    for (name, bytes) in files {
        archive_size = archive_size.saturating_add(512 + bytes.len().div_ceil(512) * 512);
        size = size
            .checked_add(bytes.len())
            .ok_or_else(|| invalid("tab size overflow"))?;
        if size as u64 > MAX_TAB_BYTES
            || archive_size as u64 > MAX_TAB_BYTES - 64 * 1024
            || !is_clean_relative_path(name)
            || name
                .split('/')
                .any(|part| part.starts_with('.') || part == "node_modules")
            || !(name == "tab.json"
                || manifest.icon.as_ref() == Some(name)
                || name.starts_with(&prefix))
        {
            if manifest
                .backend
                .as_ref()
                .is_some_and(|backend| backend.binary.values().any(|cmd| cmd == name))
            {
                return Err(invalid(format!(
                    "backend executable {name} belongs in its own archive (cadencr registry pack-tab-backend), not the web archive"
                )));
            }
            return Err(invalid(format!(
                "unexpected or oversized tab payload: {name}"
            )));
        }
    }
    if let Some(icon) = &manifest.icon {
        let bytes = files
            .get(icon)
            .ok_or_else(|| invalid("declared tab icon is missing"))?;
        if bytes.len() as u64 > cadencr_plugin_core::tab::MAX_ICON_BYTES
            || !std::str::from_utf8(bytes).is_ok_and(|text| text.contains("<svg"))
        {
            return Err(invalid("invalid tab SVG icon"));
        }
    }
    Ok(manifest)
}
/// Bind the compiled runtime manifest to its signed marketplace identity,
/// native backend included.
pub fn validate_tab_package_files(
    package: &serde_json::Value,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<TabManifest, RegistryError> {
    validate_tab_package_binding(package, files).map(|(manifest, _)| manifest)
}
/// [`validate_tab_package_files`], also returning the signed backend
/// (`package` is the `{tab, host}` body) the manifest is bound to.
pub fn validate_tab_package_binding(
    package: &serde_json::Value,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(TabManifest, Option<crate::SignedTabBackend>), RegistryError> {
    let manifest = validate_tab_files(files)?;
    if package["tab"]["id"] != manifest.id
        || package["tab"]["version"] != manifest.version
        || package["tab"]["api_version"] != manifest.api_version
        || package["tab"]["name"] != manifest.name
    {
        return Err(invalid("signed tab metadata differs from tab.json"));
    }
    let backend = crate::tab_backend::signed_tab_backend(package)?;
    crate::tab_backend::bind(&manifest, backend.as_ref(), files)?;
    Ok((manifest, backend))
}
fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_tabs_require_a_built_entry_and_exclude_author_sources() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("stage");
        std::fs::create_dir_all(staging.join("dist/assets")).unwrap();
        std::fs::write(staging.join("tab.json"), r#"{"schema_version":1,"kind":"tab","id":"graph","name":"Graph","version":"1.0.0","api_version":1,"entry":"dist/index.html"}"#).unwrap();
        std::fs::write(staging.join("dist/index.html"), "<html></html>").unwrap();
        std::fs::write(staging.join("dist/assets/app.js"), "console.log('graph')").unwrap();
        let pack = |name: &str| {
            pack_tab(
                PackTabRequest::builder()
                    .directory(&staging)
                    .output(&root.path().join(name))
                    .build(),
            )
        };
        let a = pack("a.tar.gz").unwrap();
        assert_eq!(a.sha256, pack("b.tar.gz").unwrap().sha256);
        let bytes = std::fs::read(&a.archive).unwrap();
        let mut files = read_tab_archive_bytes(&bytes).unwrap();
        assert_eq!(files.len(), 3);
        files.remove("dist/index.html");
        assert!(validate_tab_files(&files).is_err());
        std::fs::write(staging.join("source.ts"), "never distribute").unwrap();
        assert!(pack("bad.tar.gz").is_err());
        let mut trailing = bytes;
        trailing.push(0);
        assert!(read_tab_archive_bytes(&trailing).is_err());
    }

    #[test]
    fn oversized_sources_are_rejected_before_an_archive_is_written() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("stage");
        std::fs::create_dir_all(staging.join("dist")).unwrap();
        std::fs::write(staging.join("tab.json"), r#"{"schema_version":1,"kind":"tab","id":"graph","name":"Graph","version":"1.0.0","api_version":1,"entry":"dist/index.html"}"#).unwrap();
        for name in ["index.html", "data.bin"] {
            std::fs::File::create(staging.join("dist").join(name))
                .unwrap()
                .set_len(17 * 1024 * 1024)
                .unwrap();
        }
        let output = root.path().join("tab.tar.gz");
        let error = pack_tab(
            PackTabRequest::builder()
                .directory(&staging)
                .output(&output)
                .build(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("32 MiB"));
        assert!(!output.exists());
        assert!(snapshot_tab_folder(&staging).is_err());
        std::fs::write(staging.join("tab.json"), vec![b' '; 64 * 1024 + 1]).unwrap();
        assert!(snapshot_tab_folder(&staging).is_err());
    }
}
