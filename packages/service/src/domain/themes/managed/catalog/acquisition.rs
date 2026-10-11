//! Downloads stay async; catalog-sized verification and private cache IO do not.
use super::{cache, download, ingest_trusted, invalid, recommended_versions, source, verify};
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::domain::themes::managed::{models::*, storage};
use crate::error::AppError;
use std::{collections::BTreeMap, future::Future, path::PathBuf};

#[derive(Clone)]
struct Context {
    root: PathBuf,
    trust: ManagedTrustStore,
}
struct VerifiedCatalog {
    index: SignedMixedCatalog,
    recommendations: BTreeMap<String, String>,
}
impl VerifiedCatalog {
    fn new(index: SignedMixedCatalog) -> Self {
        Self {
            recommendations: recommended_versions(&index),
            index,
        }
    }
}
pub async fn acquire(refresh: bool) -> ManagedThemeCatalogResponse {
    let context = Context {
        root: storage::root(),
        trust: pinned_index_trust_store(),
    };
    let policy_error = super::super::policy::refresh(refresh)
        .await
        .err()
        .map(|error| error.to_string());
    let (result, refresh_error) = acquire_or_cached(
        context,
        refresh,
        source().map(|url| download(url, cadencr_registry_core::MAX_CATALOG_BYTES)),
    )
    .await;
    match result {
        Ok(catalog) => ManagedThemeCatalogResponse {
            index: Some(catalog.index),
            recommended_versions: catalog.recommendations,
            verified: true,
            error: match (refresh_error, policy_error) {
                (Some(catalog), Some(policy)) => Some(format!("{catalog}; {policy}")),
                (catalog, policy) => catalog.or(policy),
            },
        },
        Err(error) => ManagedThemeCatalogResponse {
            index: None,
            recommended_versions: Default::default(),
            verified: false,
            error: Some(error.to_string()),
        },
    }
}
async fn acquire_or_cached(
    context: Context,
    refresh: bool,
    fetch: Option<impl Future<Output = Result<Vec<u8>, AppError>> + Send>,
) -> (Result<VerifiedCatalog, AppError>, Option<String>) {
    match acquire_inner(context.clone(), refresh, fetch).await {
        Ok(index) => (Ok(index), None),
        Err(error) => {
            let fallback = worker(context.root, move || load_cached(&context.trust)).await;
            match fallback {
                Ok(index) => (Ok(index), Some(error.to_string())),
                Err(cache_error) => (
                    Err(invalid(format!(
                        "{error}; verified cache unavailable: {cache_error}"
                    ))),
                    None,
                ),
            }
        }
    }
}
async fn acquire_inner(
    context: Context,
    refresh: bool,
    fetch: Option<impl Future<Output = Result<Vec<u8>, AppError>> + Send>,
) -> Result<VerifiedCatalog, AppError> {
    let trust = context.trust.clone();
    let (cached, present) = worker(context.root.clone(), move || {
        storage::secure(&storage::root())?;
        let missing = matches!(cache().symlink_metadata(), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
        Ok((load_cached(&trust), !missing))
    })
    .await?;
    let cached = match cached {
        Ok(index) if !refresh => return Ok(index),
        cached => cached,
    };
    let Some(fetch) = fetch else {
        return match cached {
            Ok(index) => Ok(index),
            Err(error) if present => Err(error),
            Err(_) => Err(invalid("theme catalog source is not configured")),
        };
    };
    let bytes = fetch.await?;
    worker(context.root, move || {
        let value = cadencr_registry_core::parse_json_bytes(&bytes).map_err(invalid)?;
        let index = serde_json::from_value(value).map_err(invalid)?;
        ingest_trusted(&index, &context.trust)?;
        Ok(VerifiedCatalog::new(index))
    })
    .await
}
fn load_cached(trust: &ManagedTrustStore) -> Result<VerifiedCatalog, AppError> {
    let index = storage::bounded_json::<SignedMixedCatalog>(&cache())?;
    verify(&index, trust, false)?;
    Ok(VerifiedCatalog::new(index))
}
async fn worker<T: Send + 'static>(
    root: PathBuf,
    operation: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(move || storage::with_root(root, operation))
        .await
        .map_err(invalid)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn large_catalog() -> (SignedMixedCatalog, ManagedTrustStore) {
        let (mut index, trust) = super::super::tests::signed();
        let template = index.signed.packages[0].clone();
        index.signed.packages.clear();
        for version in 0..1_000 {
            let mut package = template.clone();
            package["package"]["theme"]["version"] = format!("1.0.{version}").into();
            package["package"]["theme"]["description"] = "x".repeat(4_096).into();
            index.signed.packages.push(package);
        }
        index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[19; 32])
                .sign(&cadencr_registry_core::canonical_json_bytes(
                    &serde_json::to_value(&index.signed).unwrap(),
                ))
                .to_bytes(),
        );
        (index, trust)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cache_refresh_and_fallback_keep_large_catalog_work_off_the_async_worker() {
        let (index, trust) = large_catalog();
        let bytes = serde_json::to_vec(&index).unwrap();
        assert!(bytes.len() > 4 * 1024 * 1024);
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let context = Context {
            root: root.path().to_path_buf(),
            trust,
        };
        worker(context.root.clone(), move || {
            storage::secure(&storage::root())?;
            crate::shared::atomic_file::write_atomic_private(
                &cache(),
                &serde_json::to_string(&index).unwrap(),
            )
        })
        .await
        .unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let tick_count = count.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::task::yield_now().await;
                tick_count.fetch_add(1, Ordering::Relaxed);
            }
        });
        for phase in 0..3 {
            let before = count.load(Ordering::Relaxed);
            let response = if phase == 0 {
                acquire_or_cached(
                    context.clone(),
                    false,
                    None::<std::future::Ready<Result<Vec<u8>, AppError>>>,
                )
                .await
            } else if phase == 1 {
                acquire_or_cached(
                    context.clone(),
                    true,
                    Some(std::future::ready(Ok(bytes.clone()))),
                )
                .await
            } else {
                acquire_or_cached(
                    context.clone(),
                    true,
                    Some(std::future::ready(Err(invalid("offline fixture")))),
                )
                .await
            };
            let catalogue = response.0.unwrap();
            assert_eq!(catalogue.index.signed.packages.len(), 1_000);
            assert_eq!(catalogue.recommendations["midnight"], "1.0.999");
            assert_eq!(response.1.is_some(), phase == 2);
            assert!(count.load(Ordering::Relaxed) > before);
        }
        heartbeat.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn captured_storage_root_survives_offloading_and_does_not_block_timers() {
        let root = tempfile::tempdir().unwrap();
        let expected = root.path().to_path_buf();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let task = tokio::spawn(worker(expected.clone(), move || {
            entered_tx.send(storage::root()).unwrap();
            release_rx.recv().unwrap();
            Ok(storage::root())
        }));
        assert_eq!(entered_rx.await.unwrap(), expected);
        let timer = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::time::sleep(std::time::Duration::from_millis(1)),
        )
        .await;
        release_tx.send(()).unwrap();
        assert!(timer.is_ok());
        assert_eq!(task.await.unwrap().unwrap(), expected);
    }
}
