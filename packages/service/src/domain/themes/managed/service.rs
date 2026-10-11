use super::models::*;
use super::{archive, catalog, storage};
use crate::domain::agents::providers::installed::managed::trust::pinned_index_trust_store;
use crate::domain::settings_store;
use crate::domain::themes::models::{CreateThemeResponse, UserTheme};
use crate::error::AppError;
use std::sync::OnceLock;

fn lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub use super::inventory::inventory;
pub use super::read::preview;
use super::read::{preview_trusted, read_theme};
async fn staged(
    body: &InstallManagedThemeRequest,
) -> Result<(tempfile::TempDir, Receipt), AppError> {
    catalog::ingest(&body.index)?;
    let package = catalog::resolve(&body.index, &body.theme_id, &body.version)?;
    storage::owner(&body.theme_id)?;
    let archive_url = package["theme"]["distribution"]["archive"]
        .as_str()
        .ok_or_else(|| archive::invalid("theme archive URL missing"))?;
    let sha256 = package["theme"]["distribution"]["sha256"]
        .as_str()
        .ok_or_else(|| archive::invalid("theme archive digest missing"))?;
    storage::revision(&body.theme_id, &body.version, sha256)?;
    super::policy::refresh(false).await?;
    super::policy::enforce(&body.theme_id, &body.version, sha256)?;
    let bytes = catalog::download_archive(
        archive_url,
        package["theme"]["repository"].as_str(),
        archive::MAX_ARCHIVE_BYTES,
    )
    .await?;
    if storage::digest(&bytes) != sha256 {
        return Err(AppError::coded(
            axum::http::StatusCode::BAD_REQUEST,
            "MANAGED_THEME_HASH_MISMATCH",
            "theme archive digest does not match signed catalog",
        ));
    }
    storage::secure(&storage::root())?;
    let stage = storage::staging()?;
    storage::write_archive(stage.path(), &bytes)?;
    archive::extract(&bytes, &stage.path().join("payload"))?;
    let validated =
        cadencr_plugin_core::theme::validate_theme_folder(&stage.path().join("payload"))
            .map_err(|issues| archive::invalid(format!("{issues:?}")))?;
    let files = validated
        .files
        .iter()
        .map(|(name, bytes)| (name.clone(), storage::digest(bytes)))
        .collect();
    Ok((
        stage,
        Receipt {
            index: body.index.clone(),
            id: body.theme_id.clone(),
            version: body.version.clone(),
            sha256: sha256.into(),
            files,
        },
    ))
}
pub async fn preview_package(body: InstallManagedThemeRequest) -> Result<UserTheme, AppError> {
    let (stage, _) = staged(&body).await?;
    read_theme(&stage.path().join("payload"), &body.theme_id)
}
pub async fn install(
    body: InstallManagedThemeRequest,
    update: bool,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    install_with_stage(&body, update, staged(&body)).await
}
async fn install_with_stage(
    body: &InstallManagedThemeRequest,
    update: bool,
    staging: impl std::future::Future<Output = Result<(tempfile::TempDir, Receipt), AppError>>,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    ensure_install_state(&body.theme_id, update)?;
    let (stage, receipt) = staging.await?;
    let _guard = lock().lock().await;
    ensure_install_state(&body.theme_id, update)?;
    catalog::ingest(&body.index)?;
    super::policy::enforce(&receipt.id, &receipt.version, &receipt.sha256)?;
    commit_staged(body, stage, receipt)
}
fn ensure_install_state(id: &str, update: bool) -> Result<(), AppError> {
    if storage::owner(id)?.join("active.json").exists() != update {
        return Err(archive::invalid(if update {
            "theme is not installed"
        } else {
            "theme is already installed"
        }));
    }
    Ok(())
}
fn commit_staged(
    body: &InstallManagedThemeRequest,
    stage: tempfile::TempDir,
    receipt: Receipt,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    let destination = storage::revision(&receipt.id, &receipt.version, &receipt.sha256)?;
    if destination.exists() {
        let pointer = Pointer {
            version: receipt.version.clone(),
            sha256: receipt.sha256.clone(),
        };
        super::read::preview_revision_trusted(&receipt.id, pointer, &pinned_index_trust_store())?;
        let previous: Receipt = storage::receipt(&destination.join("receipt.json"))?;
        if previous.files != receipt.files {
            return Err(archive::invalid("immutable theme revision content differs"));
        }
        storage::activate(
            &receipt.id,
            &Pointer {
                version: receipt.version.clone(),
                sha256: receipt.sha256.clone(),
            },
        )?;
    } else {
        storage::commit(stage.path(), &receipt)?;
    }
    preview(&body.theme_id)
}
pub async fn apply(id: &str) -> Result<ManagedThemeInventoryEntry, AppError> {
    apply_trusted(id, &pinned_index_trust_store()).await
}
async fn apply_trusted(
    id: &str,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<ManagedThemeInventoryEntry, AppError> {
    let _guard = lock().lock().await;
    preview_trusted(id, trust)?;
    settings_store::global_set("theme_current", &format!("managed:{id}")).await?;
    settings_store::global_set("theme_follow_system", "false").await?;
    preview_trusted(id, trust)
}
pub async fn remove(id: &str, confirm: bool) -> Result<RemoveManagedThemeResponse, AppError> {
    remove_inner(id, confirm).await
}
async fn remove_inner(id: &str, confirm: bool) -> Result<RemoveManagedThemeResponse, AppError> {
    let _guard = lock().lock().await;
    let owner = storage::owner(id)?;
    std::fs::symlink_metadata(&owner).map_err(archive::invalid)?;
    storage::secure(&owner)?;
    let key = format!("managed:{id}");
    let settings = settings_store::global_snapshot()
        .ok_or_else(|| archive::invalid("settings are unreadable; refusing theme removal"))?;
    let keys = ["theme_current", "theme_system_light", "theme_system_dark"];
    let referenced = keys.iter().any(|name| settings.get(*name) == Some(&key));
    if referenced && !confirm {
        return Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "MANAGED_THEME_FALLBACK_CONFIRMATION_REQUIRED",
            "confirm built-in fallback before removing a selected theme",
        ));
    }
    for name in keys {
        if settings.get(name) == Some(&key) {
            settings_store::global_set(
                name,
                if name == "theme_system_light" {
                    "cadencr-light"
                } else {
                    "cadencr-dark"
                },
            )
            .await?;
        }
    }
    crate::shared::trash::move_to_trash(&storage::owner(id)?).await?;
    Ok(RemoveManagedThemeResponse {
        success: true,
        fallback: referenced.then(|| "cadencr-dark".into()),
    })
}
pub async fn duplicate(
    pool: &sqlx::SqlitePool,
    id: &str,
    label: &str,
) -> Result<CreateThemeResponse, AppError> {
    duplicate_trusted(pool, id, label, &pinned_index_trust_store()).await
}
async fn duplicate_trusted(
    pool: &sqlx::SqlitePool,
    id: &str,
    label: &str,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<CreateThemeResponse, AppError> {
    let _guard = lock().lock().await;
    let source = preview_trusted(id, trust)?;
    let document = source
        .theme
        .ok_or_else(|| archive::invalid("theme is unavailable"))?
        .theme
        .ok_or_else(|| archive::invalid("theme is invalid"))?;
    let pointer = storage::pointer(id)?;
    let folder = cadencr_plugin_core::theme::validate_theme_folder(
        &storage::revision(id, &pointer.version, &pointer.sha256)?.join("payload"),
    )
    .map_err(|issues| archive::invalid(format!("{issues:?}")))?;
    let archive_bytes = storage::regular(
        &storage::revision(id, &pointer.version, &pointer.sha256)?.join("archive.tar.gz"),
        archive::MAX_ARCHIVE_BYTES,
    )?;
    if storage::digest(&archive_bytes) != pointer.sha256
        || cadencr_registry_core::read_theme_archive_bytes(&archive_bytes)
            .map_err(archive::invalid)?
            != folder.files
    {
        return Err(archive::invalid(
            "theme changed while preparing author copy",
        ));
    }
    let mut theme = super::super::store::create()
        .label(label)
        .appearance(document.appearance)
        .css_vars(document.css_vars)
        .xterm(document.xterm)
        .chrome(document.chrome)
        .call()
        .await?;
    for (name, bytes) in folder.files {
        if name != "theme.json" {
            let path = super::super::paths::theme_dir(&theme.id)?.join(name);
            std::fs::write(path, bytes).map_err(archive::invalid)?;
        }
    }
    theme = super::super::store::get(&theme.id).await?;
    let workspace = super::super::workspace::ensure(pool, &theme.id).await?;
    Ok(CreateThemeResponse { theme, workspace })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    #[tokio::test]
    async fn pending_download_does_not_hold_the_lifecycle_lock() {
        let (index, _) = catalog::tests::signed();
        let body = InstallManagedThemeRequest {
            index,
            theme_id: "new-theme".into(),
            version: "1.0.0".into(),
        };
        let (started, receiver) = tokio::sync::oneshot::channel();
        let staging = async {
            started.send(()).unwrap();
            std::future::pending::<Result<(tempfile::TempDir, Receipt), AppError>>().await
        };
        tokio::select! {
            result = install_with_stage(&body, false, staging) => panic!("unexpected staging result: {result:?}"),
            result = async {
                receiver.await.unwrap();
                tokio::time::timeout(std::time::Duration::from_secs(1), lock().lock()).await
            } => { assert!(result.is_ok(), "network staging must not lock other themes"); }
        }
    }
    pub(in crate::domain::themes::managed) fn commit_fixture(
        id: &str,
        version: &str,
    ) -> crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore {
        let (mut index, trust) = catalog::tests::signed();
        index.signed.packages[0]["package"]["theme"]["id"] = serde_json::json!(id);
        index.signed.packages[0]["package"]["theme"]["version"] = serde_json::json!(version);
        storage::secure(&storage::root()).unwrap();
        let stage = storage::staging().unwrap();
        storage::secure(&stage.path().join("payload")).unwrap();
        let document = crate::domain::themes::models::ThemeDocument {
            schema: None,
            label: "Midnight".into(),
            appearance: crate::domain::themes::models::ThemeAppearance::Dark,
            css_vars: crate::domain::themes::test_support::dracula_css_vars(),
            xterm: crate::domain::themes::test_support::dracula_xterm(),
            chrome: Default::default(),
        };
        let bytes = serde_json::to_vec(&document).unwrap();
        crate::shared::atomic_file::write_atomic_private(
            &stage.path().join("payload/theme.json"),
            std::str::from_utf8(&bytes).unwrap(),
        )
        .unwrap();
        let archive_path = stage.path().join("archive.tar.gz");
        let packed = cadencr_registry_core::pack_theme(
            cadencr_registry_core::PackThemeRequest::builder()
                .directory(&stage.path().join("payload"))
                .output(&archive_path)
                .build(),
        )
        .unwrap();
        let archive_bytes = std::fs::read(&archive_path).unwrap();
        // Recreate with the same private-file policy as production staging.
        std::fs::remove_file(&archive_path).unwrap();
        storage::write_archive(stage.path(), &archive_bytes).unwrap();
        index.signed.packages[0]["package"]["theme"]["distribution"]["sha256"] =
            packed.sha256.clone().into();
        let key = ed25519_dalek::SigningKey::from_bytes(&[19; 32]);
        index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            key.sign(&cadencr_registry_core::canonical_json_bytes(
                &serde_json::to_value(&index.signed).unwrap(),
            ))
            .to_bytes(),
        );
        let receipt = Receipt {
            index,
            id: id.into(),
            version: version.into(),
            sha256: packed.sha256,
            files: std::collections::BTreeMap::from([(
                "theme.json".into(),
                storage::digest(&bytes),
            )]),
        };
        storage::commit(stage.path(), &receipt).unwrap();
        trust
    }
    #[tokio::test]
    async fn immutable_install_apply_update_remove_requires_builtin_fallback() {
        let trust = commit_fixture("midnight", "1.0.0");
        let old_digest = storage::pointer("midnight").unwrap().sha256;
        let installed = preview_trusted("midnight", &trust).unwrap();
        assert_eq!(installed.theme.unwrap().id, "managed:midnight");
        assert!(!installed.active);
        settings_store::global_set("theme_system_light", "managed:midnight")
            .await
            .unwrap();
        assert!(preview_trusted("midnight", &trust).unwrap().active);
        assert!(apply_trusted("midnight", &trust).await.unwrap().active);
        settings_store::global_set("theme_system_dark", "managed:midnight")
            .await
            .unwrap();
        let trust = commit_fixture("midnight", "1.1.0");
        assert_eq!(
            preview_trusted("midnight", &trust).unwrap().version,
            "1.1.0"
        );
        assert!(storage::revision("midnight", "1.0.0", &old_digest)
            .unwrap()
            .exists());
        let old = Pointer {
            version: "1.0.0".into(),
            sha256: old_digest.clone(),
        };
        super::super::read::preview_revision_trusted(
            "midnight",
            Pointer {
                version: old.version.clone(),
                sha256: old.sha256.clone(),
            },
            &trust,
        )
        .unwrap();
        storage::activate("midnight", &old).unwrap();
        assert_eq!(
            preview_trusted("midnight", &trust).unwrap().version,
            "1.0.0"
        );
        std::fs::write(
            storage::revision("midnight", "1.0.0", &old_digest)
                .unwrap()
                .join("payload/theme.json"),
            b"broken",
        )
        .unwrap();
        assert!(preview_trusted("midnight", &trust).is_err());
        assert!(remove_inner("midnight", false).await.is_err());
        assert!(remove_inner("midnight", true).await.unwrap().success);
        assert_eq!(
            settings_store::global_get("theme_current").as_deref(),
            Some("cadencr-dark")
        );
        assert_eq!(
            settings_store::global_get("theme_system_light").as_deref(),
            Some("cadencr-light")
        );
        assert_eq!(
            settings_store::global_get("theme_system_dark").as_deref(),
            Some("cadencr-dark")
        );
    }
    #[test]
    fn modified_revision_data_cannot_be_previewed_or_applied() {
        let trust = commit_fixture("midnight", "1.0.0");
        let file = storage::revision(
            "midnight",
            "1.0.0",
            &storage::pointer("midnight").unwrap().sha256,
        )
        .unwrap()
        .join("payload/theme.json");
        let bytes = std::fs::read_to_string(&file)
            .unwrap()
            .replace("Midnight", "Tampered");
        crate::shared::atomic_file::write_atomic_private(&file, &bytes).unwrap();
        assert!(preview_trusted("midnight", &trust).is_err());
    }
    #[tokio::test]
    async fn forged_payload_and_receipt_cannot_replace_authenticated_archive() {
        let trust = commit_fixture("forged-theme", "1.0.0");
        let pointer = storage::pointer("forged-theme").unwrap();
        let revision =
            storage::revision("forged-theme", &pointer.version, &pointer.sha256).unwrap();
        let path = revision.join("payload/theme.json");
        let forged = std::fs::read_to_string(&path)
            .unwrap()
            .replace("Midnight", "Forged");
        crate::shared::atomic_file::write_atomic_private(&path, &forged).unwrap();
        let mut receipt = storage::receipt(&revision.join("receipt.json")).unwrap();
        receipt
            .files
            .insert("theme.json".into(), storage::digest(forged.as_bytes()));
        crate::shared::atomic_file::write_atomic_private(
            &revision.join("receipt.json"),
            &serde_json::to_string(&receipt).unwrap(),
        )
        .unwrap();
        assert!(preview_trusted("forged-theme", &trust).is_err());
        assert!(apply_trusted("forged-theme", &trust).await.is_err());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .unwrap();
        assert!(duplicate_trusted(&pool, "forged-theme", "Copy", &trust)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn missing_or_tampered_original_archive_fails_closed() {
        let trust = commit_fixture("archive-theme", "1.0.0");
        let pointer = storage::pointer("archive-theme").unwrap();
        let path = storage::revision("archive-theme", &pointer.version, &pointer.sha256)
            .unwrap()
            .join("archive.tar.gz");
        crate::shared::atomic_file::write_atomic_private(&path, "tampered").unwrap();
        assert!(preview_trusted("archive-theme", &trust).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(preview_trusted("archive-theme", &trust).is_err());
        assert!(remove_inner("archive-theme", false).await.unwrap().success);
    }
}
