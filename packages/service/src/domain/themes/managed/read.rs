//! Read verified immutable revisions without admitting filesystem edits.
use super::models::*;
use super::{archive, catalog, storage};
use crate::domain::agents::providers::installed::managed::trust::pinned_index_trust_store;
use crate::domain::settings_store;
use crate::domain::themes::models::UserTheme;
use crate::error::AppError;
use base64::Engine as _;
pub fn preview(id: &str) -> Result<ManagedThemeInventoryEntry, AppError> {
    preview_trusted(id, &pinned_index_trust_store())
}
pub(super) fn preview_trusted(
    id: &str,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    let pointer = storage::pointer(id)?;
    preview_revision_trusted(id, pointer, trust)
}
pub(super) fn preview_revision_trusted(
    id: &str,
    pointer: Pointer,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    let selected = format!("managed:{id}");
    let active = ["theme_current", "theme_system_light", "theme_system_dark"]
        .iter()
        .any(|key| settings_store::global_get(key).as_deref() == Some(&selected));
    preview_revision_snapshot(id, pointer, trust, &super::policy::snapshot()?, active)
}
pub(super) fn preview_snapshot(
    id: &str,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
    policy: &super::policy::Snapshot,
    active: bool,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    preview_revision_snapshot(id, storage::pointer(id)?, trust, policy, active)
}
fn preview_revision_snapshot(
    id: &str,
    pointer: Pointer,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
    policy: &super::policy::Snapshot,
    active: bool,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    let revision = storage::revision(id, &pointer.version, &pointer.sha256)?;
    storage::secure(&revision)?;
    let receipt: Receipt = storage::receipt(&revision.join("receipt.json"))?;
    if receipt.id != id || receipt.version != pointer.version || receipt.sha256 != pointer.sha256 {
        return Err(archive::invalid("theme receipt identity mismatch"));
    }
    catalog::verify(&receipt.index, trust, true)?;
    let package = catalog::resolve(&receipt.index, id, &receipt.version)?;
    if package["theme"]["distribution"]["sha256"] != receipt.sha256 {
        return Err(archive::invalid(
            "theme receipt digest is absent from signed catalog",
        ));
    }
    policy.enforce(id, &pointer.version, &pointer.sha256)?;
    storage::secure(&revision.join("payload"))?;
    let actual_files = std::fs::read_dir(revision.join("payload"))
        .map_err(archive::invalid)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(archive::invalid)?;
    if actual_files.len() != receipt.files.len()
        || actual_files.iter().any(|entry| {
            !entry
                .file_name()
                .to_str()
                .is_some_and(|name| receipt.files.contains_key(name))
        })
    {
        return Err(archive::invalid(
            "immutable theme contains undeclared files",
        ));
    }
    let validated = cadencr_plugin_core::theme::validate_theme_folder(&revision.join("payload"))
        .map_err(|issues| archive::invalid(format!("{issues:?}")))?;
    if validated.files.len() != receipt.files.len()
        || validated
            .files
            .keys()
            .any(|name| !receipt.files.contains_key(name))
    {
        return Err(archive::invalid("theme receipt file inventory mismatch"));
    }
    for (name, hash) in &receipt.files {
        let bytes = storage::regular(
            &revision.join("payload").join(name),
            archive::MAX_ARCHIVE_BYTES,
        )?;
        if validated.files.get(name) != Some(&bytes) || storage::digest(&bytes) != *hash {
            return Err(archive::invalid("immutable theme file hash mismatch"));
        }
    }
    let theme = render_theme(&revision.join("payload"), id, validated)?;
    Ok(ManagedThemeInventoryEntry {
        id: id.into(),
        name: package["theme"]["name"].as_str().unwrap_or(id).into(),
        version: pointer.version,
        sha256: pointer.sha256,
        active,
        theme: Some(theme),
        error: None,
        error_code: None,
    })
}
pub fn read_theme(directory: &std::path::Path, id: &str) -> Result<UserTheme, AppError> {
    let validated = cadencr_plugin_core::theme::validate_theme_folder(directory)
        .map_err(|issues| archive::invalid(format!("{issues:?}")))?;
    render_theme(directory, id, validated)
}
fn render_theme(
    directory: &std::path::Path,
    id: &str,
    validated: cadencr_plugin_core::theme::ValidatedThemeFolder,
) -> Result<UserTheme, AppError> {
    let content =
        String::from_utf8(validated.files["theme.json"].clone()).map_err(archive::invalid)?;
    let mut assets = std::collections::BTreeMap::new();
    for (name, bytes) in &validated.files {
        if name == "theme.json" {
            continue;
        }
        let mime =
            crate::shared::image_file::image_or_svg_mime_for_path(std::path::Path::new(name))
                .ok_or_else(|| archive::invalid("unknown raster MIME"))?;
        assets.insert(
            name.clone(),
            format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        );
    }
    Ok(UserTheme {
        id: format!("managed:{id}"),
        path: directory.join("theme.json").display().to_string(),
        content,
        label: Some(validated.document.label.clone()),
        theme: Some(validated.document),
        issues: vec![],
        assets,
    })
}
