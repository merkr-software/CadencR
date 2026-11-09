use std::path::PathBuf;

use super::{PreparePublicationPackageRequest, PreparedPublicationPackage, MAX_METADATA_BYTES};
use crate::domain::projects::publication_storage;
use crate::error::AppError;

pub(super) fn build(
    project_id: i64,
    project_root: PathBuf,
    plugin_id: String,
    output_root: PathBuf,
    body: PreparePublicationPackageRequest,
) -> Result<PreparedPublicationPackage, AppError> {
    if !body.target.is_empty() || !body.staging_directory.is_empty() {
        return Err(AppError::BadRequest(
            "themes and tabs have no platform target or external staging directory".into(),
        ));
    }
    if body.metadata_json.len() > MAX_METADATA_BYTES {
        return Err(AppError::BadRequest(
            "publication metadata exceeds 64 KiB".into(),
        ));
    }
    let metadata = cadencr_registry_core::parse_json_bytes(body.metadata_json.as_bytes())
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    cadencr_registry_core::validate_marketplace_package(&metadata)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let kind = metadata["kind"].as_str().unwrap_or_default();
    if !matches!(kind, "theme" | "tab") || metadata["package"][kind]["id"] != plugin_id {
        return Err(AppError::BadRequest(
            "package identity does not match author project".into(),
        ));
    }
    let files = if kind == "tab" {
        let files = cadencr_registry_core::snapshot_tab_folder(&project_root)
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        if metadata["package"]["tab"].get("backend").is_some()
            || cadencr_registry_core::validate_tab_files(&files)
                .map_err(|e| AppError::BadRequest(e.to_string()))?
                .backend
                .is_some()
        {
            return Err(AppError::BadRequest(
                "tabs with a native backend are published with `cadencr registry pack-tab` and `cadencr registry pack-tab-backend` (one archive per platform), not Prepare publication".into(),
            ));
        }
        cadencr_registry_core::validate_tab_package_files(&metadata["package"], &files)
            .map_err(|error| AppError::BadRequest(error.to_string()))?;
        files
    } else {
        cadencr_plugin_core::theme::validate_theme_folder(&project_root)
            .map_err(|issues| {
                AppError::BadRequest(
                    issues
                        .iter()
                        .map(cadencr_plugin_core::theme::ThemeIssue::describe)
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            })?
            .files
    };
    let prospective = super::output::prospective_path(&output_root)?;
    super::input::reject_output_overlap(&prospective, &project_root, &project_root)?;
    super::quota::ensure_capacity(&output_root)?;
    super::output::require_real_directory_if_present(&output_root)?;
    std::fs::create_dir_all(&output_root).map_err(|error| io_error(error))?;
    let parent = output_root.join(project_id.to_string());
    super::output::require_real_directory_if_present(&parent)?;
    std::fs::create_dir_all(&parent).map_err(|error| io_error(error))?;
    let parent = parent.canonicalize().map_err(|error| io_error(error))?;
    super::input::reject_output_overlap(&parent, &project_root, &project_root)?;
    let bundle =
        publication_storage::create_unique_directory(&parent).map_err(|error| io_error(error))?;
    let result = write_bundle()
        .project_id(project_id)
        .plugin_id(plugin_id)
        .bundle(bundle.as_path())
        .files(files)
        .metadata(metadata)
        .call();
    if result.is_err() {
        for name in ["theme.tar.gz", "tab.tar.gz", "package.json"] {
            let path = bundle.join(name);
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(error)),
            }
        }
        std::fs::remove_dir(&bundle).map_err(|error| io_error(error))?;
    }
    result
}

#[bon::builder]
fn write_bundle(
    project_id: i64,
    plugin_id: String,
    bundle: &std::path::Path,
    files: std::collections::BTreeMap<String, Vec<u8>>,
    mut metadata: serde_json::Value,
) -> Result<PreparedPublicationPackage, AppError> {
    let staging = tempfile::tempdir_in(bundle).map_err(|error| io_error(error))?;
    for (name, bytes) in files {
        if let Some(parent) = staging.path().join(&name).parent() {
            std::fs::create_dir_all(parent).map_err(|error| io_error(error))?;
        }
        publication_storage::write_exclusive_synced(&staging.path().join(name), &bytes)
            .map_err(|error| io_error(error))?;
    }
    let kind = metadata["kind"].as_str().unwrap_or_default().to_owned();
    let archive_path = bundle.join(format!("{kind}.tar.gz"));
    let (sha256, size) = if kind == "tab" {
        let packed = cadencr_registry_core::pack_tab(
            cadencr_registry_core::PackTabRequest::builder()
                .directory(staging.path())
                .output(&archive_path)
                .build(),
        )
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
        (packed.sha256, packed.size)
    } else {
        let packed = cadencr_registry_core::pack_theme(
            cadencr_registry_core::PackThemeRequest::builder()
                .directory(staging.path())
                .output(&archive_path)
                .build(),
        )
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
        (packed.sha256, packed.size)
    };
    metadata["package"][&kind]["distribution"]["sha256"] = sha256.clone().into();
    let metadata_path = bundle.join("package.json");
    publication_storage::write_exclusive_synced(
        &metadata_path,
        &serde_json::to_vec_pretty(&metadata)
            .map_err(|error| AppError::internal(error.to_string()))?,
    )
    .map_err(|error| io_error(error))?;
    Ok(PreparedPublicationPackage {
        project_id,
        plugin_id,
        target: String::new(),
        archive_path: archive_path.display().to_string(),
        metadata_path: metadata_path.display().to_string(),
        sha256,
        size,
    })
}

#[track_caller]
fn io_error(error: std::io::Error) -> AppError {
    AppError::internal(format!("theme publication package storage: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &std::path::Path) -> String {
        use cadencr_plugin_core::theme::{schema, tokens};
        let mut vars = serde_json::Map::new();
        for token in tokens::REQUIRED_TOKENS {
            vars.insert((*token).into(), json!("#000000"));
        }
        for pair in tokens::CONTRAST_PAIRS {
            vars.insert(pair.foreground.into(), json!("#ffffff"));
        }
        let schema: serde_json::Value = serde_json::from_str(&schema::render()).unwrap();
        let xterm = schema["properties"]["xterm"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(|key| (key.clone(), json!("#ffffff")))
            .collect::<serde_json::Map<_, _>>();
        std::fs::write(
            root.join("theme.json"),
            json!({"label":"Theme","appearance":"dark","cssVars":vars,"xterm":xterm}).to_string(),
        )
        .unwrap();
        json!({"kind":"theme","package":{"theme":{"id":"acme-theme","name":"Acme","description":"Theme","version":"1.0.0","license":"MIT","repository":"https://github.com/acme/theme","document_version":1,"distribution":{"archive":"https://github.com/acme/theme/releases/download/v1.0.0/theme.tar.gz","sha256":"0".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"},"assets":{"icon":"icon.png","readme":"README.md","license":"LICENSE"}}}}).to_string()
    }

    #[test]
    fn authored_tree_is_snapshotted_to_closed_declarative_archive() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let metadata_json = fixture(&project);
        std::fs::create_dir(project.join(".git")).unwrap();
        std::fs::write(project.join("scaffold.js"), "never package").unwrap();
        let response = build(
            1,
            project.clone(),
            "acme-theme".into(),
            root.path().join("output"),
            PreparePublicationPackageRequest {
                metadata_json: metadata_json.clone(),
                target: String::new(),
                staging_directory: String::new(),
            },
        )
        .unwrap();
        assert!(response.target.is_empty());
        let file = std::fs::File::open(&response.archive_path).unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let names = archive
            .entries()
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(names, ["theme.json"]);
        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(response.metadata_path).unwrap()).unwrap();
        assert_eq!(
            metadata["package"]["theme"]["distribution"]["sha256"],
            response.sha256
        );
        assert!(metadata.pointer("/package/agent").is_none());
        std::fs::write(project.join("theme.json"), "{}").unwrap();
        assert!(build(
            1,
            project,
            "acme-theme".into(),
            root.path().join("output"),
            PreparePublicationPackageRequest {
                metadata_json,
                target: String::new(),
                staging_directory: String::new()
            }
        )
        .is_err());
    }
    #[test]
    fn tab_bundle_excludes_sources() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("graph");
        std::fs::create_dir_all(project.join("dist")).unwrap();
        std::fs::write(project.join("tab.json"), r#"{"schema_version":1,"kind":"tab","id":"graph","name":"Graph","version":"1.0.0","api_version":1,"entry":"dist/index.html"}"#).unwrap();
        std::fs::write(project.join("dist/index.html"), "<html>Graph</html>").unwrap();
        std::fs::write(project.join("source.ts"), "source must stay local").unwrap();
        let metadata = json!({"kind":"tab","package":{"tab":{"id":"graph","name":"Graph","description":"A graph","version":"1.0.0","api_version":1,"license":"MIT","repository":"https://github.com/acme/tabs","distribution":{"archive":"https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz","sha256":"0".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}});
        let response = build(
            1,
            project,
            "graph".into(),
            temp.path().join("output"),
            PreparePublicationPackageRequest {
                metadata_json: metadata.to_string(),
                target: String::new(),
                staging_directory: String::new(),
            },
        )
        .unwrap();
        let bytes = std::fs::read(&response.archive_path).unwrap();
        let files = cadencr_registry_core::read_tab_archive_bytes(&bytes).unwrap();
        assert_eq!(
            files.keys().cloned().collect::<Vec<_>>(),
            ["dist/index.html", "tab.json"]
        );
    }
    #[test]
    fn backend_tabs_are_refused_with_the_cli_route() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("ports");
        std::fs::create_dir_all(project.join("dist")).unwrap();
        std::fs::write(project.join("tab.json"), r#"{"schema_version":1,"kind":"tab","id":"ports","name":"Ports","version":"1.0.0","api_version":1,"entry":"dist/index.html","backend":{"protocol":1,"reasoning":"Lists ports.","binary":{"linux-x86_64":"bin/ports"}}}"#).unwrap();
        std::fs::write(project.join("dist/index.html"), "<html>Ports</html>").unwrap();
        let metadata = json!({"kind":"tab","package":{"tab":{"id":"ports","name":"Ports","description":"Ports","version":"1.0.0","api_version":1,"license":"MIT","repository":"https://github.com/acme/tabs","distribution":{"archive":"https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz","sha256":"0".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}});
        let error = build(
            1,
            project,
            "ports".into(),
            temp.path().join("output"),
            PreparePublicationPackageRequest {
                metadata_json: metadata.to_string(),
                target: String::new(),
                staging_directory: String::new(),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("pack-tab-backend"), "{error}");
        assert!(!temp.path().join("output").exists());
    }
}
