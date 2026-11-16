use super::{
    invalid, policy, require_host_target, signed_backend, storage, InstallManagedTabRequest,
    ManagedTabInventoryEntry,
};
use crate::{
    domain::marketplace::{catalog, storage as io},
    error::AppError,
};

mod install;
use install::{install_bytes, require_install};

static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn inventory() -> Result<Vec<ManagedTabInventoryEntry>, AppError> {
    let root = storage::root();
    let policy = policy::current()?;
    tokio::task::spawn_blocking(move || {
        let mut entries = Vec::new();
        for id in storage::ids(&root)? {
            let entry = match storage::read(&root, &id) {
                Ok(revision) => {
                    let (pending_version, error) = match storage::read_pending(&root, &id) {
                        Ok(pending) => (pending.map(|pending| pending.manifest.version), None),
                        Err(error) => (
                            None,
                            Some(format!("the staged update cannot be verified: {error}")),
                        ),
                    };
                    let blocked = policy.installed_blocked_reason(
                        &id,
                        &revision.manifest.version,
                        &revision.facts,
                    );
                    ManagedTabInventoryEntry {
                        pending_version,
                        error,
                        ..ManagedTabInventoryEntry::from_revision(id, revision, blocked)
                    }
                }
                Err(error) => ManagedTabInventoryEntry {
                    name: id.clone(),
                    id,
                    version: String::new(),
                    error: Some(error.to_string()),
                    pending_version: None,
                    platform: None,
                    blocked: None,
                },
            };
            entries.push(entry);
        }
        Ok(entries)
    })
    .await
    .map_err(invalid)?
}

/// Download and install (or update) a signed tab. `consented` is the hash the
/// user last accepted: an update that would run something new is staged
/// beside the active revision instead of replacing it (see `install_bytes`).
pub async fn install(
    body: InstallManagedTabRequest,
    update: bool,
    consented: Option<String>,
) -> Result<ManagedTabInventoryEntry, AppError> {
    let root = storage::root();
    let catalog_root = io::root();
    storage::owner(&root, &body.tab_id)?;
    let local = super::super::paths::tabs_dir().join(&body.tab_id);
    let index = catalog::verified_catalog().await?;
    let package = catalog::resolve_kind(&index, &body.tab_id, &body.version, "tab")?;
    let distribution = &package["tab"]["distribution"];
    let signed = signed_backend(&body.tab_id, &package)?;
    let target = signed
        .as_ref()
        .map(|backend| require_host_target(&body.tab_id, backend).map(|(_, target)| target))
        .transpose()?;
    // Nothing is downloaded for a revision the (refreshed) policy blocks.
    let policy = policy::refresh(false).await?;
    require_install(
        &policy,
        &body,
        &package,
        target.map(|target| target.executable_sha256.as_str()),
    )?;
    let backend_download = async {
        match target {
            None => Ok(None),
            Some(target) => catalog::download_archive(
                crate::domain::marketplace::ExtensionKind::Tab,
                &target.archive,
                distribution.get("repository"),
                target.size as usize,
            )
            .await
            .map(Some),
        }
    };
    let archive = distribution["archive"]
        .as_str()
        .ok_or_else(|| invalid("tab archive missing"))?;
    let (backend_archive, bytes) = tokio::try_join!(
        backend_download,
        catalog::download_archive(
            crate::domain::marketplace::ExtensionKind::Tab,
            archive,
            distribution.get("repository"),
            cadencr_registry_core::MAX_TAB_BYTES as usize,
        )
    )?;
    let _guard = MUTATION.lock().await;
    // The catalog may have advanced during the download: commit against the
    // verified one now, which still has to publish these exact bytes.
    let index = catalog::verified_catalog().await?;
    tokio::task::spawn_blocking(move || {
        io::with_root(catalog_root, || {
            install_bytes()
                .root(root)
                .local(local)
                .body(body)
                .index(&index)
                .bytes(bytes)
                .maybe_backend_archive(backend_archive)
                .update(update)
                .maybe_consented(consented)
                .call()
        })
    })
    .await
    .map_err(invalid)?
}

pub async fn remove(id: String) -> Result<(), AppError> {
    let root = storage::root();
    let _guard = MUTATION.lock().await;
    tokio::task::spawn_blocking(move || storage::deactivate(&root, &id))
        .await
        .map_err(invalid)?
}

/// The user accepted the staged update of `id`: it becomes the active
/// revision. 409 `MANAGED_TAB_UPDATE_CHANGED` if `revision` is no longer the
/// one staged.
pub async fn promote_pending(id: String, revision: String) -> Result<(), AppError> {
    let root = storage::root();
    let _guard = MUTATION.lock().await;
    tokio::task::spawn_blocking(move || storage::promote_pending(&root, &id, &revision))
        .await
        .map_err(invalid)?
}

/// Drop the staged update of `id`; the active revision stays.
pub async fn discard_pending(id: String) -> Result<(), AppError> {
    let root = storage::root();
    let _guard = MUTATION.lock().await;
    tokio::task::spawn_blocking(move || storage::discard_pending(&root, &id))
        .await
        .map_err(invalid)?
}
