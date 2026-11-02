use std::path::Path;

use serde_json::json;

use crate::{operation_error, output, Diagnostic};

/// `cadencr plugin validate <folder> --kind theme`.
pub(crate) fn validate(
    folder: &Path,
    descriptor: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    if descriptor.is_some() {
        return Err(operation_error(
            "THEME_VALIDATION_FAILED",
            "--descriptor is not used for declarative themes",
        ));
    }
    validate_folder(folder).map(Some)
}

/// [`validate`] without the argument check, for `--kind plugin` members too.
pub(crate) fn validate_folder(folder: &Path) -> Result<String, Diagnostic> {
    let theme = cadencr_plugin_core::theme::validate_theme_folder(folder).map_err(|issues| {
        operation_error(
            "THEME_VALIDATION_FAILED",
            issues
                .iter()
                .map(cadencr_plugin_core::theme::ThemeIssue::describe)
                .collect::<Vec<_>>()
                .join("; "),
        )
    })?;
    Ok(format!(
        "valid declarative theme: {} ({})",
        theme.document.label,
        theme.directory.display()
    ))
}

pub(crate) fn pack(directory: &Path, destination: &Path) -> Result<Option<String>, Diagnostic> {
    let archive = cadencr_registry_core::pack_theme(
        cadencr_registry_core::PackThemeRequest::builder()
            .directory(directory)
            .output(destination)
            .build(),
    )
    .map_err(|error| operation_error("THEME_PACKAGING_FAILED", error))?;
    output::write_receipt(
        &json!({
            "kind":"theme", "archive":archive.archive, "sha256":archive.sha256, "size":archive.size,
        }),
        "THEME_PACKAGING_FAILED",
    )
}
