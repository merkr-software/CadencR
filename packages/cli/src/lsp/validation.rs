use std::path::Path;

use cadencr_registry_core::{LspDescriptor, LspTarget};

use crate::{operation_error, Diagnostic};

#[bon::builder]
pub(crate) fn validate(
    folder: &Path,
    descriptor: Option<&Path>,
    target: Option<&str>,
    archive: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    if descriptor.is_some() {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "LSP members declare their signed package in lsp.json",
        ));
    }
    validate_payload(folder, target, archive).map(|(_, message)| Some(message))
}
pub(crate) fn validate_folder(folder: &Path) -> Result<(LspDescriptor, String), Diagnostic> {
    validate_payload(folder, None, None)
}

fn validate_payload(
    folder: &Path,
    selected: Option<&str>,
    archive: Option<&Path>,
) -> Result<(LspDescriptor, String), Diagnostic> {
    let metadata = std::fs::symlink_metadata(folder)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "LSP folder must be a real directory",
        ));
    }
    let bytes = cadencr_plugin_core::read_regular_bounded(&folder.join("lsp.json"), 1024 * 1024)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    let parsed = cadencr_registry_core::parse_marketplace_package(&value)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    let cadencr_registry_core::MarketplacePackage::Lsp(package) = parsed else {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "lsp.json must declare kind lsp",
        ));
    };
    if let Some(platform) = selected {
        if !package.lsp.distribution.binary.contains_key(platform) {
            return Err(operation_error(
                "LSP_VALIDATION_FAILED",
                format!("selected target is not declared in lsp.json: {platform}"),
            ));
        }
    }
    for (platform, target) in &package.lsp.distribution.binary {
        if selected.is_some_and(|selected| selected != platform) {
            continue;
        }
        validate_entry(folder, platform, target)?;
        if let Some(archive) = archive {
            let bytes = cadencr_plugin_core::read_regular_bounded(
                archive,
                cadencr_registry_core::MAX_LSP_ARCHIVE_BYTES,
            )
            .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
            cadencr_registry_core::read_lsp_archive(&bytes, platform, target)
                .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
        }
    }
    let mut message = format!(
        "valid language-server metadata: {} {} ({})",
        package.lsp.id,
        package.lsp.version,
        folder.display()
    );
    if let Some(platform) = selected {
        message.push_str(&format!(
            "; payload checked for {platform}; other target payloads were not checked"
        ));
    }
    if archive.is_some() {
        message.push_str("; signed archive verified");
    }
    Ok((package.lsp, message))
}

fn validate_entry(folder: &Path, platform: &str, target: &LspTarget) -> Result<(), Diagnostic> {
    let path = folder.join(&target.entry);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || path
            .canonicalize()
            .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?
            != folder
                .canonicalize()
                .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?
                .join(&target.entry)
    {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "entry must be a regular file reached without symlinks",
        ));
    }
    let bytes = cadencr_plugin_core::read_regular_bounded(
        &path,
        cadencr_registry_core::MAX_LSP_UNCOMPRESSED_BYTES,
    )
    .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    cadencr_registry_core::validate_lsp_entry(&bytes, platform, target)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))
}
