//! Official signed marketplace catalog acquisition and verified cache fallback.

use std::fmt;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt as _;
use serde::Serialize;

use super::trust::{ManagedTrustStore, VerifiedManagedProviderIndex};
use super::SignedProviderCatalog;

mod cache;
mod recommendation;

const MAX_CATALOG_BYTES: usize = cadencr_registry_core::MAX_CATALOG_BYTES;
const CATALOG_REFRESH_TIMEOUT: Duration = Duration::from_secs(15);
const CATALOG_REFRESH_CADENCE: chrono::Duration = chrono::Duration::hours(1);

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Release-owned source compiled into the service. Request input cannot override it.
pub fn pinned_catalog_url() -> Option<&'static str> {
    option_env!("CADENCR_MANAGED_PROVIDER_INDEX_URL").filter(|value| !value.trim().is_empty())
}

#[derive(Debug, Clone, Copy, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedCatalogCacheStatus {
    Missing,
    Verified,
    Invalid,
    Expired,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ManagedCatalogResponse {
    pub source_configured: bool,
    pub cache_status: ManagedCatalogCacheStatus,
    pub refreshed: bool,
    pub used_cached_verified_catalog: bool,
    pub signer_key_id: Option<String>,
    pub generated_at: Option<String>,
    pub expires_at: Option<String>,
    pub index: Option<SignedProviderCatalog>,
    /// Host-compatible recommendation per provider, outside the signed payload.
    #[serde(default)]
    pub recommended_versions: std::collections::BTreeMap<String, String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

impl ManagedCatalogResponse {
    fn unconfigured() -> Self {
        let mut response = Self::unavailable(None);
        response.error_code = Some("MANAGED_CATALOG_SOURCE_NOT_CONFIGURED".into());
        response.error =
            Some("managed provider catalog source is not configured in this build".into());
        response
    }

    pub fn unavailable(error: Option<ManagedCatalogError>) -> Self {
        let (cache_status, error_code, message) =
            error.map_or((ManagedCatalogCacheStatus::Missing, None, None), |error| {
                (
                    if error.code == ManagedCatalogErrorCode::Expired {
                        ManagedCatalogCacheStatus::Expired
                    } else {
                        ManagedCatalogCacheStatus::Invalid
                    },
                    Some(error.code.as_str().to_string()),
                    Some(error.message),
                )
            });
        Self {
            source_configured: pinned_catalog_url().is_some(),
            cache_status,
            refreshed: false,
            used_cached_verified_catalog: false,
            signer_key_id: None,
            generated_at: None,
            expires_at: None,
            index: None,
            recommended_versions: Default::default(),
            error_code,
            error: message,
        }
    }

    fn verified(
        catalog: &VerifiedManagedProviderIndex,
        refreshed: bool,
        fallback_error: Option<ManagedCatalogError>,
    ) -> Self {
        let index = catalog.index();
        Self {
            source_configured: pinned_catalog_url().is_some(),
            cache_status: ManagedCatalogCacheStatus::Verified,
            refreshed,
            used_cached_verified_catalog: !refreshed,
            signer_key_id: Some(catalog.signer_key_id().to_string()),
            generated_at: Some(index.generated_at.to_rfc3339()),
            expires_at: Some(index.expires_at.to_rfc3339()),
            index: Some(catalog.envelope().clone()),
            recommended_versions: recommendation::recommended_versions(
                &index.packages,
                env!("CARGO_PKG_VERSION"),
                crate::domain::agents::providers::installed::descriptor::current_binary_target(),
            ),
            error_code: fallback_error
                .as_ref()
                .map(|error| error.code.as_str().into()),
            error: fallback_error.map(|error| error.message),
        }
    }
}

pub(crate) fn admit_request(
    path: &Path,
    trust: &ManagedTrustStore,
    index: SignedProviderCatalog,
) -> Result<(), crate::error::AppError> {
    cache::persist(path, trust, index, Utc::now())
        .map(|_| ())
        .map_err(|error| {
            crate::error::AppError::coded(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                error.code.as_str(),
                error.message,
            )
        })
}

pub async fn acquire(
    client: &reqwest::Client,
    cache_path: &Path,
    trust: &ManagedTrustStore,
    force_refresh: bool,
) -> ManagedCatalogResponse {
    let Some(url) = pinned_catalog_url() else {
        let cached = cache::load(cache_path, trust, Utc::now());
        return match cached {
            Ok(Some(catalog)) => ManagedCatalogResponse::verified(&catalog.verified, false, None),
            Ok(None) => ManagedCatalogResponse::unconfigured(),
            Err(error) => ManagedCatalogResponse::unavailable(Some(error)),
        };
    };
    // Cover acquisition rather than only the final write: concurrent stale
    // readers must not download and verify the same publication independently.
    let _guard = refresh_lock().lock().await;
    let now = Utc::now();
    let cached = cache::load(cache_path, trust, now);
    if !force_refresh {
        if let Ok(Some(catalog)) = &cached {
            if cache_is_recent(catalog.cached_at, now) {
                return ManagedCatalogResponse::verified(&catalog.verified, false, None);
            }
        }
    }
    match refresh(client, url, cache_path, trust).await {
        Ok(catalog) => ManagedCatalogResponse::verified(&catalog, true, None),
        Err(refresh_error) => match cached.and_then(|catalog| {
            catalog
                .map(|catalog| cache::revalidate(catalog, Utc::now()))
                .transpose()
        }) {
            Ok(Some(catalog)) => {
                ManagedCatalogResponse::verified(&catalog.verified, false, Some(refresh_error))
            }
            Ok(None) => ManagedCatalogResponse::unavailable(Some(refresh_error)),
            Err(cache_error) => ManagedCatalogResponse::unavailable(Some(cache_error)),
        },
    }
}

fn cache_is_recent(cached_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    // The wrapper timestamp is unsigned; a future value must not defer refresh.
    cached_at <= now && now - cached_at < CATALOG_REFRESH_CADENCE
}

async fn refresh(
    client: &reqwest::Client,
    url: &str,
    cache_path: &Path,
    trust: &ManagedTrustStore,
) -> Result<VerifiedManagedProviderIndex, ManagedCatalogError> {
    tokio::time::timeout(
        CATALOG_REFRESH_TIMEOUT,
        refresh_inner(client, url, cache_path, trust),
    )
    .await
    .map_err(|_| download("catalog refresh timed out after 15 seconds"))?
}

async fn refresh_inner(
    client: &reqwest::Client,
    url: &str,
    cache_path: &Path,
    trust: &ManagedTrustStore,
) -> Result<VerifiedManagedProviderIndex, ManagedCatalogError> {
    let url = reqwest::Url::parse(url)
        .map_err(|error| download(format!("catalog URL is invalid: {error}")))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(download("catalog URL must be absolute HTTPS"));
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| download(format!("catalog download failed: {error}")))?
        .error_for_status()
        .map_err(|error| download(format!("catalog download failed: {error}")))?;
    if response.url().scheme() != "https" {
        return Err(download("catalog redirect resolved outside HTTPS"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| download(format!("catalog download failed: {error}")))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CATALOG_BYTES {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: SignedProviderCatalog = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("downloaded catalog is invalid: {error}")))?;
    // Freshness is a property at acceptance time, not request-start time. A
    // catalog can expire while a slow response is still arriving.
    cache::persist(cache_path, trust, envelope, Utc::now())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCatalogErrorCode {
    Invalid,
    Expired,
    TooLarge,
    DownloadFailed,
    Unavailable,
}

impl ManagedCatalogErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "MANAGED_CATALOG_INVALID",
            Self::Expired => "MANAGED_CATALOG_EXPIRED",
            Self::TooLarge => "MANAGED_CATALOG_TOO_LARGE",
            Self::DownloadFailed => "MANAGED_CATALOG_DOWNLOAD_FAILED",
            Self::Unavailable => "MANAGED_CATALOG_UNAVAILABLE",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedCatalogError {
    pub code: ManagedCatalogErrorCode,
    pub message: String,
}

impl ManagedCatalogError {
    fn new(code: ManagedCatalogErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl fmt::Display for ManagedCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for ManagedCatalogError {}

fn invalid(message: impl Into<String>) -> ManagedCatalogError {
    ManagedCatalogError::new(ManagedCatalogErrorCode::Invalid, message)
}
fn download(message: impl Into<String>) -> ManagedCatalogError {
    ManagedCatalogError::new(ManagedCatalogErrorCode::DownloadFailed, message)
}
fn too_large() -> ManagedCatalogError {
    ManagedCatalogError::new(
        ManagedCatalogErrorCode::TooLarge,
        "managed provider catalog exceeds 32 MiB",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_cadence_does_not_trust_future_wrapper_timestamps() {
        let now = Utc::now();
        assert!(cache_is_recent(now, now));
        assert!(cache_is_recent(now - chrono::Duration::minutes(59), now));
        assert!(!cache_is_recent(now - CATALOG_REFRESH_CADENCE, now));
        assert!(!cache_is_recent(now + chrono::Duration::seconds(1), now));
        assert!(!cache_is_recent(now + chrono::Duration::days(365), now));
    }

    #[tokio::test]
    async fn unconfigured_catalog_is_an_explicit_nonfatal_response() {
        if pinned_catalog_url().is_some() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let response = acquire(
            &reqwest::Client::new(),
            &directory.path().join("missing.json"),
            &ManagedTrustStore::default(),
            false,
        )
        .await;
        assert!(!response.source_configured);
        assert!(matches!(
            response.cache_status,
            ManagedCatalogCacheStatus::Missing
        ));
        assert!(response.index.is_none());
        assert_eq!(
            response.error_code.as_deref(),
            Some("MANAGED_CATALOG_SOURCE_NOT_CONFIGURED")
        );
    }
}
