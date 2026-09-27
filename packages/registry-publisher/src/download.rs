use std::io::{Read, Write};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, LOCATION};
use reqwest::redirect::Policy;
use sha2::{Digest as _, Sha256};
use url::Url;

use crate::fs::{private_create, remove_owned, Identity};
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};

mod discovery;
pub(crate) use discovery::DiscoveryDownloader;

const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub(crate) struct ProductionDownloader {
    client: OnceLock<Result<Client, PublisherError>>,
}

impl Downloader for ProductionDownloader {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        let initial = validate_url(request.url, true)?;
        let expected = normalize_digest(request.sha256)?;
        let client = self.client()?;
        let response = fetch_final(client, initial, MAX_REDIRECTS)?;
        stream_to_file(response, &request, &expected)
    }
}

impl ProductionDownloader {
    fn client(&self) -> Result<&Client, PublisherError> {
        self.client
            .get_or_init(|| {
                Client::builder()
                    .redirect(Policy::none())
                    .timeout(TIMEOUT)
                    .build()
                    .map_err(|error| PublisherError::io("build archive client", error))
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    pub(crate) fn redirected_asset(
        &self,
        url: &str,
        request: DownloadRequest<'_>,
    ) -> Result<Downloaded, PublisherError> {
        let initial = validate_url(url, false)?;
        let expected = normalize_digest(request.sha256)?;
        let response = fetch_final(self.client()?, initial, MAX_REDIRECTS - 1)?;
        stream_to_file(response, &request, &expected)
    }
}

pub(crate) fn download_authenticated_asset(
    response: Response,
    request: DownloadRequest<'_>,
) -> Result<Downloaded, PublisherError> {
    let expected = normalize_digest(request.sha256)?;
    stream_to_file(response, &request, &expected)
}

pub(crate) fn validate_asset_expectations(url: &str, sha256: &str) -> Result<(), PublisherError> {
    validate_url(url, true)?;
    normalize_digest(sha256)?;
    Ok(())
}

fn fetch_final(
    client: &Client,
    mut current: Url,
    max_redirects: usize,
) -> Result<Response, PublisherError> {
    for redirects in 0..=max_redirects {
        let response = client
            .get(current.clone())
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(|_| PublisherError::new("archive download: request failed"))?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if redirects == max_redirects {
            return Err(PublisherError::new("archive download: too many redirects"));
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| PublisherError::new("archive download: redirect has no location"))?;
        let next = current
            .join(location)
            .map_err(|_| PublisherError::new("archive download: redirect URL is invalid"))?;
        current = validate_url(next.as_str(), false)?;
    }
    unreachable!("bounded redirect loop returns")
}

fn stream_to_file(
    mut response: Response,
    request: &DownloadRequest<'_>,
    expected: &str,
) -> Result<Downloaded, PublisherError> {
    let declared = validate_response(response.status(), response.headers(), request.max_bytes)?;
    let mut file = private_create(&request.output)
        .map_err(|error| PublisherError::io("create archive output", error))?;
    let identity = Identity::from_metadata(
        &file
            .metadata()
            .map_err(|error| PublisherError::io("inspect archive output", error))?,
    );
    let result = stream(&mut response, &mut file, request.max_bytes)
        .and_then(|downloaded| verify(downloaded, declared, expected))
        .and_then(|downloaded| {
            file.sync_all()
                .map_err(|error| PublisherError::io("sync archive", error))?;
            Ok(downloaded)
        });
    drop(file);
    match result {
        Ok(downloaded) => Ok(downloaded),
        Err(primary) => match remove_owned(&request.output, identity) {
            Ok(()) => Err(primary),
            Err(_) => Err(PublisherError::cleanup(primary, 1)),
        },
    }
}

fn validate_response(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    max: u64,
) -> Result<Option<u64>, PublisherError> {
    if status != reqwest::StatusCode::OK {
        return Err(PublisherError::new(
            "archive download: server returned an unexpected status",
        ));
    }
    if headers
        .get(CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
    {
        return Err(PublisherError::new(
            "archive download: encoded responses are not permitted",
        ));
    }
    let Some(value) = headers.get(CONTENT_LENGTH) else {
        return Ok(None);
    };
    let text = value
        .to_str()
        .map_err(|_| PublisherError::new("archive download: invalid content length"))?;
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(PublisherError::new(
            "archive download: invalid content length",
        ));
    }
    let size = text
        .parse::<u64>()
        .map_err(|_| PublisherError::new("archive download: invalid content length"))?;
    if size > max {
        return Err(PublisherError::new(
            "archive download: archive exceeds the size limit",
        ));
    }
    Ok(Some(size))
}

fn stream(
    reader: &mut impl Read,
    writer: &mut impl Write,
    max: u64,
) -> Result<Downloaded, PublisherError> {
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| PublisherError::new("archive download: response stream failed"))?;
        if count == 0 {
            break;
        }
        size = size.checked_add(count as u64).ok_or_else(|| {
            PublisherError::new("archive download: archive exceeds the size limit")
        })?;
        if size > max {
            return Err(PublisherError::new(
                "archive download: archive exceeds the size limit",
            ));
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|error| PublisherError::io("write archive", error))?;
        hash.update(&buffer[..count]);
    }
    Ok(Downloaded {
        sha256: crate::hex(&hash.finalize()),
        size,
    })
}

fn verify(
    value: Downloaded,
    declared: Option<u64>,
    expected: &str,
) -> Result<Downloaded, PublisherError> {
    if declared.is_some_and(|size| size != value.size) {
        return Err(PublisherError::new(
            "archive download: content length does not match response body",
        ));
    }
    if value.sha256 != expected {
        return Err(PublisherError::new("archive download: SHA-256 mismatch"));
    }
    Ok(value)
}

fn validate_url(value: &str, initial: bool) -> Result<Url, PublisherError> {
    let parsed =
        Url::parse(value).map_err(|_| PublisherError::new("archive download: invalid URL"))?;
    let allowed = matches!(
        parsed.host_str(),
        Some(
            "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"
        )
    );
    let initial_path =
        parsed.host_str() == Some("github.com") && release_download_path(parsed.path());
    if parsed.scheme() != "https"
        || !allowed
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
        || (initial && !initial_path)
    {
        return Err(PublisherError::new(
            "archive download: URL is not permitted",
        ));
    }
    Ok(parsed)
}

fn release_download_path(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    parts.len() >= 7
        && parts[0].is_empty()
        && parts[1..=2].iter().all(|part| !part.is_empty())
        && parts[3..=4] == ["releases", "download"]
        && !parts[5].is_empty()
        && !parts[6].is_empty()
}

fn normalize_digest(value: &str) -> Result<String, PublisherError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PublisherError::new("archive download: invalid SHA-256"));
    }
    Ok(value.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_and_redirect_url_policy_is_closed() {
        assert!(validate_url(
            "https://github.com/acme/provider/releases/download/v1/provider.tgz?token=secret",
            true
        )
        .is_ok());
        assert!(validate_url(
            "https://release-assets.githubusercontent.com/object?token=secret",
            false
        )
        .is_ok());
        for value in [
            "http://github.com/acme/provider/releases/download/v1/a.tgz",
            "https://user@github.com/acme/provider/releases/download/v1/a.tgz",
            "https://github.com:444/acme/provider/releases/download/v1/a.tgz",
            "https://github.com/acme/provider/archive/v1.tgz",
            "https://example.com/acme/provider/releases/download/v1/a.tgz",
        ] {
            assert!(validate_url(value, true).is_err(), "{value}");
        }
    }

    #[test]
    fn stream_is_bounded_and_hashes_exact_bytes() {
        let mut output = Vec::new();
        let result = stream(&mut &b"abc"[..], &mut output, 3).unwrap();
        assert_eq!(output, b"abc");
        assert_eq!(
            result.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(stream(&mut &b"abcd"[..], &mut Vec::new(), 3).is_err());
    }

    #[test]
    fn response_policy_rejects_status_encoding_length_and_oversize() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let empty = HeaderMap::new();
        assert!(validate_response(reqwest::StatusCode::NOT_FOUND, &empty, 3).is_err());
        for (name, value) in [
            (CONTENT_ENCODING, "gzip"),
            (CONTENT_LENGTH, "01"),
            (CONTENT_LENGTH, "x"),
            (CONTENT_LENGTH, "4"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(name, HeaderValue::from_static(value));
            assert!(validate_response(reqwest::StatusCode::OK, &headers, 3).is_err());
        }
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("3"));
        assert_eq!(
            validate_response(reqwest::StatusCode::OK, &headers, 3).unwrap(),
            Some(3)
        );
    }

    #[test]
    fn declared_length_and_digest_verification_are_exact() {
        let value = Downloaded {
            sha256: "a".repeat(64),
            size: 3,
        };
        assert!(verify(value.clone(), Some(2), &value.sha256).is_err());
        assert!(verify(value.clone(), Some(4), &value.sha256).is_err());
        assert!(verify(value.clone(), Some(3), &"b".repeat(64)).is_err());
        assert_eq!(
            verify(value.clone(), Some(3), &value.sha256).unwrap(),
            value
        );
    }
}
