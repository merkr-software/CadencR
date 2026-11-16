use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;

use super::{normalize_digest, TIMEOUT};

mod policy;
mod transport;
#[cfg(test)]
use crate::Downloader;
use crate::{DownloadRequest, Downloaded, PublisherError};
use policy::validate_url;
#[cfg(test)]
pub(crate) use transport::classify;
use transport::download_with;

/// Downloader restricted to the one canonical, public discovery object.
#[derive(Default)]
pub(crate) struct DiscoveryDownloader {
    client: OnceLock<Result<Client, PublisherError>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DiscoveryObservation {
    Candidate(Downloaded),
    Previous,
}

pub(crate) trait DiscoveryReader {
    fn observe(
        &self,
        request: DownloadRequest<'_>,
        previous: Option<&str>,
        remaining: Duration,
    ) -> Result<DiscoveryObservation, PublisherError>;
}

// Archive fixtures remain strict; only the raw reader recognizes previous bytes.
#[cfg(test)]
impl<T: Downloader> DiscoveryReader for T {
    fn observe(
        &self,
        request: DownloadRequest<'_>,
        _previous: Option<&str>,
        _remaining: Duration,
    ) -> Result<DiscoveryObservation, PublisherError> {
        self.download(request).map(DiscoveryObservation::Candidate)
    }
}

impl DiscoveryReader for DiscoveryDownloader {
    fn observe(
        &self,
        request: DownloadRequest<'_>,
        previous: Option<&str>,
        remaining: Duration,
    ) -> Result<DiscoveryObservation, PublisherError> {
        let deadline = std::time::Instant::now() + remaining;
        let url = validate_url(request.url)?;
        if request.max_bytes > cadencr_registry_core::MAX_DISCOVERY_BYTES as u64
            || remaining.is_zero()
        {
            return Err(PublisherError::new("public discovery: invalid read budget"));
        }
        let expected = normalize_digest(request.sha256)?;
        if let Some(previous) = previous {
            normalize_digest(previous)?;
        }
        let client = self.client()?;
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(PublisherError::new(
                "public discovery: read budget exhausted",
            ));
        }
        download_with()
            .client(client)
            .url(url)
            .request(&request)
            .expected(&expected)
            .maybe_previous(previous)
            .remaining(remaining)
            .call()
    }
}

impl DiscoveryDownloader {
    fn client(&self) -> Result<&Client, PublisherError> {
        self.client
            .get_or_init(|| {
                Client::builder()
                    .redirect(Policy::none())
                    .timeout(TIMEOUT)
                    .build()
                    .map_err(|error| PublisherError::io("build discovery client", error))
            })
            .as_ref()
            .map_err(Clone::clone)
    }
}
