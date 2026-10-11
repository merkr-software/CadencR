use std::path::Path;

use serde_json::json;

use crate::{operation_error, output, Diagnostic};

pub(crate) fn validate_plugin_kind(
    folder: &Path,
    descriptor: Option<&Path>,
    kind: &str,
) -> Result<Option<String>, Diagnostic> {
    if kind == "theme" {
        if descriptor.is_some() {
            return Err(operation_error(
                "THEME_VALIDATION_FAILED",
                "--descriptor is not used for declarative themes",
            ));
        }
        let theme =
            cadencr_plugin_core::theme::validate_theme_folder(folder).map_err(|issues| {
                operation_error(
                    "THEME_VALIDATION_FAILED",
                    issues
                        .iter()
                        .map(cadencr_plugin_core::theme::ThemeIssue::describe)
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            })?;
        return Ok(Some(format!(
            "valid declarative theme: {} ({})",
            theme.document.label,
            theme.directory.display()
        )));
    }
    let descriptor = descriptor.ok_or_else(|| {
        operation_error(
            "PLUGIN_DESCRIPTOR_REQUIRED",
            "provider validation requires --descriptor",
        )
    })?;
    cadencr_plugin_core::validate_plugin_folder(folder, descriptor)
        .map(|_| {
            Some(format!(
                "valid local provider structure: {} (publication completeness and theme assets not checked)",
                folder.display()
            ))
        })
        .map_err(|error| Diagnostic {
            code: error.code(),
            message: error.to_string(),
            exit_code: 1,
        })
}

pub(crate) fn pack(directory: &Path, destination: &Path) -> Result<Option<String>, Diagnostic> {
    let archive = cadencr_registry_core::pack_theme(
        cadencr_registry_core::PackThemeRequest::builder()
            .directory(directory)
            .output(destination)
            .build(),
    )
    .map_err(|error| operation_error("THEME_PACKAGING_FAILED", error))?;
    let mut receipt = serde_json::to_vec(&json!({
        "kind":"theme", "archive":archive.archive, "sha256":archive.sha256, "size":archive.size,
    }))
    .map_err(|error| operation_error("THEME_PACKAGING_FAILED", error))?;
    receipt.push(b'\n');
    output::write_stdout(&receipt, &mut std::io::stdout().lock())?;
    Ok(None)
}
