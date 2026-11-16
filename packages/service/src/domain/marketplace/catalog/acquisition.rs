//! Downloads stay async; catalog-sized verification and private cache IO do not.
use super::{cache, ingest_trusted, invalid, load_verified, source};
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::domain::marketplace::download::{download_if_modified, Fetched, Validators};
use crate::domain::marketplace::{models::*, storage};
use crate::error::AppError;
use std::{future::Future, path::PathBuf, sync::Arc};

mod shared;

#[derive(Clone)]
struct Context {
    root: PathBuf,
    trust: ManagedTrustStore,
}
#[derive(Debug, Clone)]
struct VerifiedCatalog {
    index: Arc<SignedMixedCatalog>,
}
impl VerifiedCatalog {
    fn new(index: Arc<SignedMixedCatalog>) -> Self {
        Self { index }
    }
}
pub async fn acquire_catalog(refresh: bool) -> ManagedThemeCatalogResponse {
    acquire_with_policy(refresh, std::future::ready(None)).await
}
/// Read authenticated current metadata without ever requesting the network.
pub async fn cached_catalog() -> Result<Option<Arc<SignedMixedCatalog>>, AppError> {
    worker(storage::root(), || {
        match cache().symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(invalid(error)),
            Ok(_) => {}
        }
        storage::secure(&storage::root())?;
        load_verified(&pinned_index_trust_store()).map(Some)
    })
    .await
}
/// The verified catalog an install resolves its entry from; it is never
/// fetched here, so an install never re-downloads or re-verifies it.
pub async fn verified_catalog() -> Result<Arc<SignedMixedCatalog>, AppError> {
    cached_catalog().await?.ok_or_else(|| {
        crate::error::AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "MARKETPLACE_CATALOG_UNAVAILABLE",
            "marketplace catalog has not been fetched yet; refresh the marketplace and try again",
        )
    })
}
/// Acquire the catalog while `policy` refreshes a kind's revocation feed;
/// the policy's warning joins the catalog's.
pub async fn acquire_with_policy(
    refresh: bool,
    policy: impl Future<Output = Option<String>>,
) -> ManagedThemeCatalogResponse {
    let context = Context {
        root: storage::root(),
        trust: pinned_index_trust_store(),
    };
    let fetch = source().map(|url| {
        move |known: Option<Validators>| async move {
            download_if_modified(
                url,
                cadencr_registry_core::MAX_CATALOG_BYTES,
                known.as_ref(),
            )
            .await
        }
    });
    let (catalog, policy_error) = tokio::join!(shared::acquire(context, refresh, fetch), policy);
    let (result, refresh_error) = &*catalog;
    match result {
        Ok(catalog) => ManagedThemeCatalogResponse {
            index: Some((*catalog.index).clone()),
            recommended_versions: Default::default(),
            verified: true,
            error: match (refresh_error.clone(), policy_error) {
                (Some(catalog), Some(policy)) => Some(format!("{catalog}; {policy}")),
                (catalog, policy) => catalog.or(policy),
            },
            host_platform: None,
            blocked_versions: Default::default(),
            unavailable_versions: Default::default(),
        },
        Err(error) => ManagedThemeCatalogResponse {
            index: None,
            recommended_versions: Default::default(),
            verified: false,
            error: Some(error.to_string()),
            host_platform: None,
            blocked_versions: Default::default(),
            unavailable_versions: Default::default(),
        },
    }
}
async fn acquire_or_cached<F, Fut>(
    context: Context,
    refresh: bool,
    fetch: Option<F>,
) -> (Result<VerifiedCatalog, AppError>, Option<String>)
where
    F: FnOnce(Option<Validators>) -> Fut,
    Fut: Future<Output = Result<Fetched, AppError>> + Send,
{
    match acquire_inner(context.clone(), refresh, fetch).await {
        Ok(acquired) => acquired,
        Err(error) => {
            let fallback = worker(context.root, move || load_verified(&context.trust)).await;
            match fallback {
                Ok(index) => (Ok(VerifiedCatalog::new(index)), Some(error.to_string())),
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
async fn acquire_inner<F, Fut>(
    context: Context,
    refresh: bool,
    fetch: Option<F>,
) -> Result<(Result<VerifiedCatalog, AppError>, Option<String>), AppError>
where
    F: FnOnce(Option<Validators>) -> Fut,
    Fut: Future<Output = Result<Fetched, AppError>> + Send,
{
    let trust = context.trust.clone();
    let (cached, present, known) = worker(context.root.clone(), move || {
        storage::secure(&storage::root())?;
        let missing = matches!(cache().symlink_metadata(), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
        let cached = load_verified(&trust);
        // Validators only describe a body this client still holds verified.
        let known = match &cached {
            Ok(_) if refresh => validators::read(),
            _ => Ok(None),
        };
        Ok((cached, !missing, known))
    })
    .await?;
    let cached = match cached {
        Ok(index) if !refresh => return Ok((Ok(VerifiedCatalog::new(index)), None)),
        cached => cached,
    };
    let Some(fetch) = fetch else {
        return match cached {
            Ok(index) => Ok((Ok(VerifiedCatalog::new(index)), None)),
            Err(error) if present => Err(error),
            Err(_) => Err(invalid("catalog source is not configured")),
        };
    };
    let (known, mut note) = match known {
        Ok(known) => (known, None),
        Err(error) => (
            None,
            Some(format!(
                "catalog HTTP validators were unreadable, so the catalog was downloaded in full: {error}"
            )),
        ),
    };
    let (bytes, validators) = match fetch(known).await? {
        Fetched::NotModified => return Ok((cached.map(VerifiedCatalog::new), note)),
        Fetched::Body { bytes, validators } => (bytes, validators),
    };
    let trust = context.trust;
    worker(context.root, move || {
        let value = cadencr_registry_core::parse_json_bytes(&bytes).map_err(invalid)?;
        let index = serde_json::from_value(value).map_err(invalid)?;
        let index = ingest_trusted(&index, &trust)?;
        if let Err(error) = validators::write(&validators) {
            note = Some(match validators::forget() {
                Ok(()) => format!(
                    "catalog HTTP validators could not be saved ({error}); the next refresh downloads the catalog in full"
                ),
                Err(stale) => format!(
                    "catalog HTTP validators could not be saved ({error}) nor cleared ({stale})"
                ),
            });
        }
        Ok((Ok(VerifiedCatalog::new(index)), note))
    })
    .await
}
/// The validators of the body the cached catalog was admitted from, beside
/// it, with the source they came from: another source never reuses them.
mod validators {
    use super::{cache, source, storage, Validators};
    use crate::error::AppError;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Stored {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        etag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_modified: Option<String>,
    }
    fn path() -> std::path::PathBuf {
        cache().with_extension("http.json")
    }
    fn url() -> String {
        source().unwrap_or_default().to_owned()
    }
    pub(super) fn read() -> Result<Option<Validators>, AppError> {
        match path().symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => {
                let stored: Stored = storage::bounded_json(&path())?;
                Ok((stored.url == url()).then_some(Validators {
                    etag: stored.etag,
                    last_modified: stored.last_modified,
                }))
            }
        }
    }
    pub(super) fn write(validators: &Validators) -> Result<(), AppError> {
        let stored = Stored {
            url: url(),
            etag: validators.etag.clone(),
            last_modified: validators.last_modified.clone(),
        };
        let document = serde_json::to_string(&stored).map_err(super::invalid)?;
        crate::shared::atomic_file::write_atomic_private(&path(), &document)
    }
    pub(super) fn forget() -> Result<(), std::io::Error> {
        match std::fs::remove_file(path()) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
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

    fn private_context(trust: ManagedTrustStore) -> (tempfile::TempDir, Context) {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let context = Context {
            root: root.path().join("managed-themes"),
            trust,
        };
        (root, context)
    }
    type Ready = std::future::Ready<Result<Fetched, AppError>>;
    fn none() -> Option<fn(Option<Validators>) -> Ready> {
        None
    }
    /// A fetch answering `result`, recording the validators it was sent.
    fn answer(
        result: Result<Fetched, AppError>,
        sent: Arc<std::sync::Mutex<Vec<Option<Validators>>>>,
    ) -> Option<impl FnOnce(Option<Validators>) -> Ready> {
        Some(move |known| {
            sent.lock().unwrap().push(known);
            std::future::ready(result)
        })
    }
    fn body(bytes: &[u8], etag: Option<&str>) -> Result<Fetched, AppError> {
        Ok(Fetched::Body {
            bytes: bytes.to_vec(),
            validators: Validators {
                etag: etag.map(Into::into),
                last_modified: None,
            },
        })
    }

    #[tokio::test]
    async fn an_unconfigured_catalog_says_marketplace_once() {
        let (_, trust) = super::super::tests::signed();
        let (_root, context) = private_context(trust);
        let (result, _) = acquire_or_cached(context, false, none()).await;
        let message = result.unwrap_err().to_string();
        assert!(!message.contains("marketplace marketplace"), "{message}");
        assert!(
            message.starts_with("marketplace catalog source is not configured; "),
            "{message}"
        );
        // Wrapping an already prefixed error never stacks the prefix.
        let wrapped = invalid(invalid("catalog lock failed")).to_string();
        assert_eq!(wrapped, "marketplace catalog lock failed");
    }

    #[tokio::test]
    async fn a_catalog_version_is_verified_once_however_often_it_is_read() {
        let (index, trust) = super::super::tests::signed();
        let bytes = serde_json::to_vec(&index).unwrap();
        let (_root, context) = private_context(trust);
        let first = acquire_or_cached(
            context.clone(),
            true,
            answer(body(&bytes, None), Default::default()),
        )
        .await;
        assert!(first.0.is_ok(), "{:?}", first.0.err());
        let admitted = super::super::tests::signature_checks(&context.root);
        for _ in 0..3 {
            assert!(acquire_or_cached(context.clone(), false, none())
                .await
                .0
                .is_ok());
        }
        assert_eq!(
            super::super::tests::signature_checks(&context.root),
            admitted,
            "reading the verified cache again must not re-verify it"
        );
    }

    #[tokio::test]
    async fn refreshing_to_the_same_catalog_bytes_verifies_nothing_again() {
        let (index, trust) = super::super::tests::signed();
        let bytes = serde_json::to_vec(&index).unwrap();
        let (_root, context) = private_context(trust);
        let fetch = |bytes: &Vec<u8>| answer(body(bytes, None), Default::default());
        assert!(acquire_or_cached(context.clone(), true, fetch(&bytes))
            .await
            .0
            .is_ok());
        let admitted = super::super::tests::signature_checks(&context.root);
        let again = acquire_or_cached(context.clone(), true, fetch(&bytes)).await;
        assert!(again.0.is_ok() && again.1.is_none(), "{again:?}");
        assert_eq!(
            super::super::tests::signature_checks(&context.root),
            admitted
        );
    }

    #[tokio::test]
    async fn a_refresh_sends_the_validators_and_a_not_modified_answer_costs_no_check() {
        let (index, trust) = super::super::tests::signed();
        let bytes = serde_json::to_vec(&index).unwrap();
        let (_root, context) = private_context(trust);
        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        let first = acquire_or_cached(
            context.clone(),
            true,
            answer(body(&bytes, Some("\"v1\"")), sent.clone()),
        )
        .await;
        assert!(first.0.is_ok() && first.1.is_none(), "{first:?}");
        let admitted = super::super::tests::signature_checks(&context.root);
        let again = acquire_or_cached(
            context.clone(),
            true,
            answer(Ok(Fetched::NotModified), sent.clone()),
        )
        .await;
        assert!(again.0.is_ok() && again.1.is_none(), "{again:?}");
        assert_eq!(
            super::super::tests::signature_checks(&context.root),
            admitted
        );
        let sent = sent.lock().unwrap();
        assert_eq!(
            sent[0], None,
            "nothing verified yet, so nothing to revalidate"
        );
        assert_eq!(
            sent[1].as_ref().and_then(|known| known.etag.as_deref()),
            Some("\"v1\"")
        );
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
            root: root.path().join("managed-themes"),
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
                acquire_or_cached(context.clone(), false, none()).await
            } else if phase == 1 {
                acquire_or_cached(
                    context.clone(),
                    true,
                    answer(body(&bytes, None), Default::default()),
                )
                .await
            } else {
                acquire_or_cached(
                    context.clone(),
                    true,
                    answer(Err(invalid("offline fixture")), Default::default()),
                )
                .await
            };
            let catalogue = response.0.unwrap();
            assert_eq!(catalogue.index.signed.packages.len(), 1_000);
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
