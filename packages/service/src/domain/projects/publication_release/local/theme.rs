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
        "theme metadata",
    )?;
    let metadata = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|error| invalid(error.to_string()))?;
    cadencr_registry_core::validate_marketplace_package(&metadata)
        .map_err(|error| invalid(error.to_string()))?;
    if metadata["kind"] != "theme" || metadata["package"]["theme"]["id"] != plugin_id {
        return Err(invalid("theme package identity does not match project"));
    }
    let theme = &metadata["package"]["theme"];
    let text = |field: &str| {
        theme[field]
            .as_str()
            .ok_or_else(|| invalid(format!("theme {field} missing")))
    };
    let repository = super::validation::parse_repository(Some(text("repository")?))?;
    let archive = theme["distribution"]["archive"]
        .as_str()
        .ok_or_else(|| invalid("theme archive URL missing"))?;
    let (tag, archive_name) = super::validation::validate_archive_url(archive, &repository)?;
    let file =
        super::super::remote::ArchiveFile::open(&bundle.join("theme.tar.gz"), MAX_ARCHIVE_BYTES)?;
    if theme["distribution"]["sha256"].as_str() != Some(file.sha256.as_str()) {
        return Err(invalid(
            "theme archive content differs from package checksum",
        ));
    }
    let archive_bytes = read_regular(
        &bundle.join("theme.tar.gz"),
        MAX_ARCHIVE_BYTES,
        "theme archive",
    )?;
    if digest(&archive_bytes) != file.sha256 {
        return Err(invalid(
            "theme archive changed during declarative validation",
        ));
    }
    let mut snapshot =
        tempfile::NamedTempFile::new().map_err(|error| invalid(error.to_string()))?;
    std::io::Write::write_all(&mut snapshot, &archive_bytes)
        .map_err(|error| invalid(error.to_string()))?;
    cadencr_registry_core::read_theme_archive(snapshot.path())
        .map_err(|error| invalid(error.to_string()))?;
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
}

pub(in crate::domain::projects::publication_release) fn validate_project_kind(
    bytes: &[u8],
    kind: ProjectAuthoringTarget,
) -> Result<(), AppError> {
    let metadata: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| AppError::BadRequest(error.to_string()))?;
    let theme = metadata.get("kind").and_then(serde_json::Value::as_str) == Some("theme");
    if theme != (kind == ProjectAuthoringTarget::Theme) {
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
