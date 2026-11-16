use super::{invalid, platform, storage, InstallLspRequest};
use crate::domain::agents::providers::installed::managed::trust::pinned_index_trust_store;
use crate::domain::marketplace::{catalog as shared_catalog, storage as io};
use crate::error::AppError;
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

async fn lock(id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    static LOCKS: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let lock = LOCKS
        .get_or_init(Default::default)
        .lock()
        .await
        .entry(id.to_string())
        .or_default()
        .clone();
    lock.lock_owned().await
}
pub async fn install(body: InstallLspRequest, update: bool) -> Result<(), AppError> {
    let root = storage::root()?;
    storage::owner(&root, &body.lsp_id)?;
    let _lock = lock(&body.lsp_id).await;
    // The caller supplies only an identity. Downloads always come from the verified feed.
    let index = shared_catalog::verified_catalog().await?;
    let package = shared_catalog::resolve_kind(&index, &body.lsp_id, &body.version, "lsp")?;
    let target = cadencr_registry_core::signed_lsp_target(&package, platform()).map_err(invalid)?;
    super::policy::require_install(&body.lsp_id, &body.version, &target)?;
    super::super::os_requirements::require_target(&target)?;
    if target.runtime == cadencr_registry_core::LspRuntime::Node {
        super::super::spawn::node(target.node_minimum()).await?;
    }
    let active = storage::owner(&root, &body.lsp_id)?.join("active.json");
    if active.try_exists().map_err(invalid)? {
        let pointer = storage::pointer(&root, &body.lsp_id)?;
        if pointer.version == body.version && pointer.sha256 == target.sha256 {
            let id = body.lsp_id.clone();
            tokio::task::spawn_blocking(move || storage::read(&root, &id))
                .await
                .map_err(invalid)??;
            return Ok(());
        }
        if !update {
            return Err(AppError::coded(
                axum::http::StatusCode::CONFLICT,
                "LSP_ALREADY_INSTALLED",
                "LSP already installed; use update",
            ));
        }
    } else if update {
        return Err(AppError::NotFound(format!(
            "LSP {} is not installed",
            body.lsp_id
        )));
    }
    let bytes = shared_catalog::download_archive(
        crate::domain::marketplace::ExtensionKind::Lsp,
        &target.archive,
        None,
        target.size as usize,
    )
    .await?;
    tokio::task::spawn_blocking(move || {
        let _guard = _lock;
        commit()
            .root(&root)
            .body(body)
            .index((*index).clone())
            .bytes(bytes)
            .update(update)
            .trust(&pinned_index_trust_store())
            .call()
    })
    .await
    .map_err(invalid)?
}
mod revision;
use revision::commit;

pub async fn remove(id: String) -> Result<(), AppError> {
    let root = storage::root()?;
    let _lock = lock(&id).await;
    tokio::task::spawn_blocking(move || {
        let _guard = _lock;
        remove_from(&root, &id)
    })
    .await
    .map_err(invalid)?
}
fn remove_from(root: &std::path::Path, id: &str) -> Result<(), AppError> {
    let owner = storage::owner(root, id)?;
    storage::secure(root)?;
    io::with_root(root.to_path_buf(), || io::secure(&owner))?;
    crate::shared::atomic_file::write_atomic_private(&owner.join("removed.json"), "true")?;
    match std::fs::remove_file(owner.join("active.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(invalid(error)),
    }
}
