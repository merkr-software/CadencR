//! Catalog downloads that ask the server for the body only when it changed
//! (`If-None-Match` / `If-Modified-Since`), so an unchanged catalog costs
//! neither its bytes nor another signature check.
use super::{body_bytes, checked_url, client, invalid, DownloadKind};
use crate::error::AppError;
use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use serde::{Deserialize, Serialize};

/// The HTTP validators a server sent with a body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Validators {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

impl Validators {
    pub fn is_empty(&self) -> bool {
        self.etag.is_none() && self.last_modified.is_none()
    }
}

#[derive(Debug)]
pub enum Fetched {
    /// The server confirmed the body the validators describe is current.
    NotModified,
    Body {
        bytes: Vec<u8>,
        validators: Validators,
    },
}

/// Download `url` unless `known` describes the body it would return.
pub async fn download_if_modified(
    url: &str,
    limit: usize,
    known: Option<&Validators>,
) -> Result<Fetched, AppError> {
    fetch_with(
        client(DownloadKind::Catalog)?,
        checked_url(url)?,
        limit,
        known,
    )
    .await
}

pub(super) async fn fetch_with(
    client: &reqwest::Client,
    url: reqwest::Url,
    limit: usize,
    known: Option<&Validators>,
) -> Result<Fetched, AppError> {
    let mut request = client.get(url.clone());
    if let Some(known) = known {
        if let Some(etag) = &known.etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        if let Some(modified) = &known.last_modified {
            request = request.header(IF_MODIFIED_SINCE, modified);
        }
    }
    let response = request.send().await.map_err(invalid)?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        if known.is_none_or(Validators::is_empty) {
            return Err(invalid(
                "download answered not modified to an unconditional request",
            ));
        }
        tracing::debug!(target: "cadencr::marketplace", %url, "catalog not modified");
        return Ok(Fetched::NotModified);
    }
    let response = response.error_for_status().map_err(invalid)?;
    let validators = Validators {
        etag: header(&response, ETAG),
        last_modified: header(&response, LAST_MODIFIED),
    };
    let bytes = body_bytes(response, limit, DownloadKind::Catalog).await?;
    tracing::debug!(target: "cadencr::marketplace", %url, bytes = bytes.len(), "catalog downloaded");
    Ok(Fetched::Body { bytes, validators })
}

/// A validator worth sending back: short, visible ASCII.
fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    let value = response.headers().get(name)?.to_str().ok()?;
    (value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' '))
    .then(|| value.to_owned())
}
