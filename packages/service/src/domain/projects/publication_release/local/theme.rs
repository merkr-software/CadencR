use super::{
    digest, invalid, read_regular, LocalRelease, Plan, MAX_ARCHIVE_BYTES, MAX_METADATA_BYTES,
};
use crate::domain::projects::models::ProjectAuthoringTarget;
use crate::error::AppError;
use std::path::PathBuf;

pub(super) fn load(
    project_id: i64,
    plugin_id: String,
    bundle: PathBuf,
    bundle_id: &str,
    release_notes: String,
) -> Result<LocalRelease, AppError> {
    let bytes = read_regular(
        &bundle.join("package.json"),
        MAX_METADATA_BYTES,
        "package metadata",
    )?;
    let metadata = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|error| invalid(error.to_string()))?;
    cadencr_registry_core::validate_marketplace_package(&metadata)
        .map_err(|error| invalid(error.to_string()))?;
    let kind = metadata["kind"].as_str().unwrap_or_default();
    if !matches!(kind, "theme" | "tab") || metadata["package"][kind]["id"] != plugin_id {
        return Err(invalid("package identity does not match project"));
    }
    let descriptor = &metadata["package"][kind];
    if kind == "tab" && descriptor.get("backend").is_some() {
        // This path uploads `tab.tar.gz` only; a native backend's per-platform
        // archives would be missing from the release its metadata points at.
        return Err(invalid(
            "tabs with a native backend are published with `cadencr registry pack-tab` and `cadencr registry pack-tab-backend` (one archive per platform) and a release holding every archive, not from a local publication bundle",
        ));
    }
    let text = |field: &str| {
        descriptor[field]
            .as_str()
            .ok_or_else(|| invalid(format!("{kind} {field} missing")))
    };
    let repository = super::validation::parse_repository(Some(text("repository")?))?;
    let archive = descriptor["distribution"]["archive"]
        .as_str()
        .ok_or_else(|| invalid("package archive URL missing"))?;
    let (tag, archive_name) = super::validation::validate_archive_url(archive, &repository)?;
    let file = super::super::remote::ArchiveFile::open(
        &bundle.join(format!("{kind}.tar.gz")),
        MAX_ARCHIVE_BYTES,
    )?;
    if descriptor["distribution"]["sha256"].as_str() != Some(file.sha256.as_str()) {
        return Err(invalid("archive content differs from package checksum"));
    }
    let archive_bytes = read_regular(
        &bundle.join(format!("{kind}.tar.gz")),
        MAX_ARCHIVE_BYTES,
        "package archive",
    )?;
    if digest(&archive_bytes) != file.sha256 {
        return Err(invalid("archive changed during package validation"));
    }
    if kind == "tab" {
        let files = cadencr_registry_core::read_tab_archive_bytes(&archive_bytes)
            .map_err(|e| invalid(e.to_string()))?;
        cadencr_registry_core::validate_tab_package_files(&metadata["package"], &files)
            .map_err(|error| invalid(error.to_string()))?;
    } else {
        cadencr_registry_core::read_theme_archive_bytes(&archive_bytes)
            .map_err(|e| invalid(e.to_string()))?;
    }
    let version =
        semver::Version::parse(text("version")?).map_err(|error| invalid(error.to_string()))?;
    Ok(LocalRelease {
        plan: Plan {
            project_id,
            plugin_id,
            version: version.to_string(),
            prerelease: !version.pre.is_empty(),
            bundle_id: bundle_id.into(),
            repository,
            tag,
            source_commit: String::new(),
            target: String::new(),
            archive_name,
            archive_sha256: file.sha256.clone(),
            archive_size: file.size,
            metadata_sha256: digest(&bytes),
            release_notes,
            archives: Vec::new(),
        },
        archive_file: file,
        declared_metadata: metadata,
        declared_targets: vec![String::new()],
        additional_archives: Vec::new(),
        metadata: bytes.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn theme_candidate_and_confirmation_bind_content_without_acp_fields() {
        let root = tempfile::tempdir().unwrap();
        let id = "00000000-0000-4000-8000-000000000001";
        let bundle = root.path().join("1").join(id);
        std::fs::create_dir_all(&bundle).unwrap();
        let staging = root.path().join("stage");
        std::fs::create_dir(&staging).unwrap();
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
            staging.join("theme.json"),
            json!({"label":"Theme","appearance":"dark","cssVars":vars,"xterm":xterm}).to_string(),
        )
        .unwrap();
        let packed = cadencr_registry_core::pack_theme(
            cadencr_registry_core::PackThemeRequest::builder()
                .directory(&staging)
                .output(&bundle.join("theme.tar.gz"))
                .build(),
        )
        .unwrap();
        let package = json!({"kind":"theme","package":{"theme":{"id":"acme-theme","name":"Acme","description":"Theme","version":"1.0.0","license":"MIT","repository":"https://github.com/acme/theme","document_version":1,"distribution":{"archive":"https://github.com/acme/theme/releases/download/v1.0.0/theme.tar.gz","sha256":packed.sha256}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"},"assets":{"icon":"icon.png","readme":"README.md","license":"LICENSE"}}}});
        std::fs::write(bundle.join("package.json"), package.to_string()).unwrap();
        let mut local = super::super::load_candidate(
            1,
            "acme-theme".into(),
            root.path().into(),
            id,
            &[],
            "Changes".into(),
        )
        .unwrap();
        assert_eq!(local.plan.archives.len(), 1);
        assert!(local.plan.target.is_empty());
        local.plan.source_commit = "a".repeat(40);
        let fingerprint =
            crate::domain::projects::publication_release::plan::plan_sha(&local.plan, "alice", 1)
                .unwrap();
        local.plan.metadata_sha256 = "b".repeat(64);
        assert_ne!(
            fingerprint,
            crate::domain::projects::publication_release::plan::plan_sha(&local.plan, "alice", 1)
                .unwrap()
        );
        let docs = crate::domain::projects::publication_release::contribution::submission::build(
            &local, "alice",
        )
        .unwrap();
        let submission: serde_json::Value = serde_json::from_slice(&docs.submission).unwrap();
        cadencr_registry_core::validate_submission(&submission).unwrap();
        assert_eq!(submission["schema_version"], 2);
        assert!(submission["package"]["package"].get("agent").is_none());
        assert!(super::super::load_candidate(
            1,
            "acme-theme".into(),
            root.path().into(),
            id,
            &[id.into()],
            "Changes".into()
        )
        .is_err());
        let mut bad_archive = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        bad_archive
            .append_data(&mut header, "script.js", &b"evil"[..])
            .unwrap();
        let bad_bytes = bad_archive.into_inner().unwrap().finish().unwrap();
        std::fs::write(bundle.join("theme.tar.gz"), &bad_bytes).unwrap();
        let mut bad_metadata = package;
        bad_metadata["package"]["theme"]["distribution"]["sha256"] = digest(&bad_bytes).into();
        std::fs::write(bundle.join("package.json"), bad_metadata.to_string()).unwrap();
        assert!(load(1, "acme-theme".into(), bundle.clone(), id, "Changes".into()).is_err());
        std::fs::write(bundle.join("theme.tar.gz"), b"tampered").unwrap();
        assert!(load(1, "acme-theme".into(), bundle, id, "Changes".into()).is_err());
    }
    #[test]
    fn custom_tab_release_reaches_schema_two_contribution() {
        let root = tempfile::tempdir().unwrap();
        let bundle_id = "00000000-0000-4000-8000-000000000002";
        let bundle = root.path().join("1").join(bundle_id);
        let stage = root.path().join("stage");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(stage.join("dist")).unwrap();
        std::fs::write(stage.join("tab.json"),r#"{"schema_version":1,"kind":"tab","id":"graph","name":"Graph","version":"1.0.0","api_version":1,"entry":"dist/index.html"}"#).unwrap();
        std::fs::write(stage.join("dist/index.html"), "<html>Graph</html>").unwrap();
        let packed = cadencr_registry_core::pack_tab(
            cadencr_registry_core::PackTabRequest::builder()
                .directory(&stage)
                .output(&bundle.join("tab.tar.gz"))
                .build(),
        )
        .unwrap();
        let metadata = json!({"kind":"tab","package":{"tab":{"id":"graph","name":"Graph","description":"Graph","version":"1.0.0","api_version":1,"repository":"https://github.com/acme/tabs","license":"MIT","distribution":{"archive":"https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz","sha256":packed.sha256}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}});
        std::fs::write(bundle.join("package.json"), metadata.to_string()).unwrap();
        let mut local = super::super::load_candidate(
            1,
            "graph".into(),
            root.path().into(),
            bundle_id,
            &[],
            "Release".into(),
        )
        .unwrap();
        validate_project_kind(&local.metadata, ProjectAuthoringTarget::Tab).unwrap();
        assert!(validate_project_kind(&local.metadata, ProjectAuthoringTarget::Provider).is_err());
        assert!(validate_project_kind(&local.metadata, ProjectAuthoringTarget::Theme).is_err());
        local.plan.source_commit = "a".repeat(40);
        let documents =
            crate::domain::projects::publication_release::contribution::submission::build(
                &local, "alice",
            )
            .unwrap();
        let submission: serde_json::Value = serde_json::from_slice(&documents.submission).unwrap();
        cadencr_registry_core::validate_submission(&submission).unwrap();
        assert_eq!(submission["package"]["kind"], "tab");
        assert!(String::from_utf8(documents.markdown)
            .unwrap()
            .contains("Custom tab version contribution"));
    }
    #[test]
    fn a_bundle_for_a_backend_tab_is_refused_before_anything_is_uploaded() {
        let root = tempfile::tempdir().unwrap();
        let bundle_id = "00000000-0000-4000-8000-000000000003";
        let bundle = root.path().join("1").join(bundle_id);
        std::fs::create_dir_all(&bundle).unwrap();
        let release = "https://github.com/acme/tabs/releases/download/v1.0.0";
        let binary = json!({"archive":format!("{release}/backend-linux-x86_64.tar.gz"),"sha256":"b".repeat(64),"size":10,"cmd":"bin/linux-x86_64/ports","executable_sha256":"c".repeat(64),"executable_size":10});
        let metadata = json!({"kind":"tab","package":{"tab":{"id":"ports","name":"Ports","description":"Ports","version":"1.0.0","api_version":1,"repository":"https://github.com/acme/tabs","license":"MIT","backend":{"protocol":1,"reasoning":"Lists ports."},"distribution":{"archive":format!("{release}/tab.tar.gz"),"sha256":"a".repeat(64),"binary":{"linux-x86_64":binary}}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}});
        cadencr_registry_core::validate_marketplace_package(&metadata).unwrap();
        std::fs::write(bundle.join("package.json"), metadata.to_string()).unwrap();
        std::fs::write(bundle.join("tab.tar.gz"), b"never read").unwrap();
        let Err(error) = load(1, "ports".into(), bundle, bundle_id, "Release".into()) else {
            panic!("a backend tab bundle must be refused");
        };
        assert!(error.to_string().contains("pack-tab-backend"), "{error}");
    }
}

pub(crate) fn validate_project_kind(
    bytes: &[u8],
    kind: ProjectAuthoringTarget,
) -> Result<(), AppError> {
    let metadata: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| AppError::BadRequest(error.to_string()))?;
    let actual = metadata
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("provider");
    if actual != kind.as_str() {
        return Err(AppError::BadRequest(
            "publication bundle kind differs from author project".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod kind_tests {
    use super::{validate_project_kind, ProjectAuthoringTarget};
    #[test]
    fn project_kind_rejects_theme_provider_swaps_before_remote_mutation() {
        let theme = br#"{"kind":"theme","package":{"theme":{"id":"same"}}}"#;
        let provider = br#"{"agent":{"id":"same"}}"#;
        assert!(validate_project_kind(theme, ProjectAuthoringTarget::Theme).is_ok());
        assert!(validate_project_kind(provider, ProjectAuthoringTarget::Provider).is_ok());
        assert!(validate_project_kind(theme, ProjectAuthoringTarget::Provider).is_err());
        assert!(validate_project_kind(provider, ProjectAuthoringTarget::Theme).is_err());
    }
}
