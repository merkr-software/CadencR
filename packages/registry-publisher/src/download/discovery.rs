use std::sync::OnceLock;

use reqwest::blocking::Client;
use reqwest::header::ACCEPT_ENCODING;
use reqwest::redirect::Policy;
use url::Url;

use super::{normalize_digest, stream_to_file, TIMEOUT};
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};

/// Downloader restricted to the one canonical, public discovery object.
#[derive(Default)]
pub(crate) struct DiscoveryDownloader {
    client: OnceLock<Result<Client, PublisherError>>,
}

impl Downloader for DiscoveryDownloader {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        let url = validate_url(request.url)?;
        if request.max_bytes > cadencr_registry_core::MAX_DISCOVERY_BYTES as u64 {
            return Err(PublisherError::new(
                "archive download: invalid discovery size limit",
            ));
        }
        let expected = normalize_digest(request.sha256)?;
        download_with(self.client()?, url, &request, &expected)
    }
}

fn download_with(
    client: &Client,
    url: Url,
    request: &DownloadRequest<'_>,
    expected: &str,
) -> Result<Downloaded, PublisherError> {
    let response = client
        .get(url)
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .map_err(|_| PublisherError::new("archive download: request failed"))?;
    if response.status().is_redirection() {
        return Err(PublisherError::new(
            "archive download: discovery redirect is not permitted",
        ));
    }
    stream_to_file(response, request, expected)
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

fn validate_url(value: &str) -> Result<Url, PublisherError> {
    let parsed = Url::parse(value)
        .map_err(|_| PublisherError::new("archive download: invalid discovery URL"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("raw.githubusercontent.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(not_permitted());
    }
    let parts = parsed.path().split('/').collect::<Vec<_>>();
    if parts.len() != 7
        || !parts[0].is_empty()
        || parts[3..=4] != ["refs", "heads"]
        || parts[6] != cadencr_registry_core::DISCOVERY_FILENAME
    {
        return Err(not_permitted());
    }
    let repository = format!("{}/{}", parts[1], parts[2]);
    let canonical =
        cadencr_registry_core::discovery_url(&repository, parts[5]).map_err(|_| not_permitted())?;
    if canonical != value {
        return Err(PublisherError::new(
            "archive download: discovery URL is not canonical",
        ));
    }
    Ok(parsed)
}

fn not_permitted() -> PublisherError {
    PublisherError::new("archive download: discovery URL is not permitted")
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use sha2::{Digest as _, Sha256};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn url_policy_is_exact() {
        let canonical =
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json";
        assert_eq!(validate_url(canonical).unwrap().as_str(), canonical);
        for value in [
            "http://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json?token=x",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/a/b/managed-index.json",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/other.json",
            "https://github.com/acme/registry/releases/download/v1/provider.tgz",
        ] {
            assert!(validate_url(value).is_err(), "{value}");
        }
        assert!(super::super::validate_url(canonical, true).is_err());
    }

    fn serve(response: Vec<u8>) -> (Url, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).unwrap();
            stream.write_all(&response).unwrap();
            String::from_utf8_lossy(&request[..count]).into_owned()
        });
        (
            Url::parse(&format!("http://{address}/discovery")).unwrap(),
            handle,
        )
    }

    fn request<'a>(output: std::path::PathBuf, sha256: &'a str) -> DownloadRequest<'a> {
        DownloadRequest {
            url: "unused after validation",
            sha256,
            output,
            max_bytes: 3,
        }
    }

    #[test]
    fn transport_refuses_redirect_status_oversize_and_removes_hash_mismatch() {
        let client = Client::builder().redirect(Policy::none()).build().unwrap();
        let directory = tempdir().unwrap();
        let expected = crate::hex(&Sha256::digest(b"abc"));
        for (name, response) in [
            (
                "redirect",
                b"HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n".to_vec(),
            ),
            (
                "status",
                b"HTTP/1.1 404 Nope\r\nContent-Length: 0\r\n\r\n".to_vec(),
            ),
            (
                "oversize",
                b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd".to_vec(),
            ),
            (
                "mismatch",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabd".to_vec(),
            ),
        ] {
            let (url, observed) = serve(response);
            let output = directory.path().join(name);
            assert!(
                download_with(&client, url, &request(output.clone(), &expected), &expected)
                    .is_err()
            );
            assert!(!output.exists());
            assert!(observed
                .join()
                .unwrap()
                .contains("accept-encoding: identity"));
        }
    }

    #[test]
    fn transport_streams_exact_body_and_hash() {
        let client = Client::builder().redirect(Policy::none()).build().unwrap();
        let expected = crate::hex(&Sha256::digest(b"abc"));
        let (url, observed) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec());
        let directory = tempdir().unwrap();
        let output = directory.path().join("managed-index.json");
        let result =
            download_with(&client, url, &request(output.clone(), &expected), &expected).unwrap();
        assert_eq!(
            result,
            Downloaded {
                sha256: expected,
                size: 3
            }
        );
        assert_eq!(std::fs::read(output).unwrap(), b"abc");
        assert!(observed
            .join()
            .unwrap()
            .starts_with("GET /discovery HTTP/1.1"));
    }
}
