use std::time::{Duration, Instant};

use reqwest::blocking::{Client, Response};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE, USER_AGENT,
};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::validation::{error, MAX_JSON_BYTES};
use crate::PublisherError;

pub(super) const API_VERSION: &str = "2026-03-10";
const TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const USER_AGENT_VALUE: &str = "Cadencr-registry-publisher";

pub(super) fn http_client() -> Result<Client, PublisherError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|error| PublisherError::io("build GitHub client", error))
}

pub(super) fn authorization(token: &str) -> Result<HeaderValue, PublisherError> {
    let mut bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| error("GitHub token is invalid"))?;
    bearer.set_sensitive(true);
    Ok(bearer)
}

pub(super) struct Requester {
    client: Client,
    base: String,
    headers: HeaderMap,
}

pub(super) enum AssetResponse {
    Bytes(Response),
    Redirect(String),
}

impl Requester {
    pub(super) fn production(token: &str) -> Result<Self, PublisherError> {
        Self::build(token, "https://api.github.com".into())
    }

    #[cfg(test)]
    pub(super) fn fixture(token: &str, base: String) -> Result<Self, PublisherError> {
        Self::build(token, base)
    }

    fn build(token: &str, base: String) -> Result<Self, PublisherError> {
        let client = http_client()?;
        let bearer = authorization(token)?;
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, bearer);
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );
        headers.insert(
            "x-github-api-version",
            HeaderValue::from_static(API_VERSION),
        );
        headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
        Ok(Self {
            client,
            base,
            headers,
        })
    }

    pub(super) fn get_with_deadline<T: DeserializeOwned>(
        &self,
        path: &str,
        deadline: Option<Instant>,
    ) -> Result<T, PublisherError> {
        self.get_bounded(path, MAX_JSON_BYTES, deadline)
    }

    pub(super) fn get_catalog_blob_with_deadline<T: DeserializeOwned>(
        &self,
        path: &str,
        deadline: Option<Instant>,
    ) -> Result<T, PublisherError> {
        // Base64, newline wrapping and a bounded JSON metadata allowance.
        let limit =
            (cadencr_registry_core::MAX_CATALOG_BYTES as u64).div_ceil(3) * 4 + 2 * 1024 * 1024;
        self.get_bounded(path, limit, deadline)
    }

    fn get_bounded<T: DeserializeOwned>(
        &self,
        path: &str,
        limit: u64,
        deadline: Option<Instant>,
    ) -> Result<T, PublisherError> {
        let request = self.bounded_get(path, deadline)?;
        let result = decode_bounded(request.send().map_err(network)?, StatusCode::OK, limit);
        check_deadline(deadline)?;
        result
    }

    pub(super) fn get_optional<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<Option<T>, PublisherError> {
        self.get_optional_with_deadline(path, None)
    }

    pub(super) fn get_optional_with_deadline<T: DeserializeOwned>(
        &self,
        path: &str,
        deadline: Option<Instant>,
    ) -> Result<Option<T>, PublisherError> {
        let response = self.bounded_get(path, deadline)?.send().map_err(network)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let result = decode(response, StatusCode::OK).map(Some);
        check_deadline(deadline)?;
        result
    }

    /// A GET whose own timeout is the time left until `deadline`, at most the
    /// client timeout.
    fn bounded_get(
        &self,
        path: &str,
        deadline: Option<Instant>,
    ) -> Result<reqwest::blocking::RequestBuilder, PublisherError> {
        let mut request = self
            .client
            .get(format!("{}{path}", self.base))
            .headers(self.headers.clone());
        if let Some(deadline) = deadline {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| error("GitHub discovery verification deadline exceeded"))?;
            request = request.timeout(remaining.min(TIMEOUT));
        }
        Ok(request)
    }

    pub(super) fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, PublisherError> {
        self.send(Method::POST, path, Some(body), StatusCode::CREATED)
    }

    pub(super) fn patch<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, PublisherError> {
        self.send(Method::PATCH, path, Some(body), StatusCode::OK)
    }

    pub(super) fn put<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
        expected: StatusCode,
    ) -> Result<T, PublisherError> {
        self.send(Method::PUT, path, Some(body), expected)
    }

    fn send<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        expected: StatusCode,
    ) -> Result<T, PublisherError> {
        let mut request = self.client.request(method, format!("{}{path}", self.base));
        request = request.headers(self.headers.clone());
        if let Some(body) = body {
            let bytes = serde_json::to_vec(body)
                .map_err(|_| error("GitHub request could not be encoded"))?;
            request = request.header(CONTENT_TYPE, "application/json").body(bytes);
        }
        decode(request.send().map_err(network)?, expected)
    }

    pub(super) fn asset_response(&self, path: &str) -> Result<AssetResponse, PublisherError> {
        let mut headers = self.headers.clone();
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .headers(headers)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(network)?;
        if response.status() == StatusCode::OK {
            return Ok(AssetResponse::Bytes(response));
        }
        if !response.status().is_redirection() {
            return Err(error("GitHub asset request returned an unexpected status"));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| error("GitHub asset response is malformed"))?;
        Ok(AssetResponse::Redirect(location))
    }
}

fn decode<T: DeserializeOwned>(
    response: Response,
    expected: StatusCode,
) -> Result<T, PublisherError> {
    decode_bounded(response, expected, MAX_JSON_BYTES)
}

fn decode_bounded<T: DeserializeOwned>(
    response: Response,
    expected: StatusCode,
    limit: u64,
) -> Result<T, PublisherError> {
    if response.status() != expected {
        return Err(error(format!(
            "GitHub API request failed with status {}",
            response.status().as_u16()
        )));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(error("GitHub API response exceeds its byte limit"));
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("GitHub API response could not be read"))?;
    if bytes.len() as u64 > limit {
        return Err(error("GitHub API response exceeds its byte limit"));
    }
    serde_json::from_slice(&bytes).map_err(|_| error("GitHub API returned malformed JSON"))
}

fn network(_: reqwest::Error) -> PublisherError {
    error("GitHub API request failed")
}

use std::io::Read as _;

pub(super) fn check_deadline(deadline: Option<Instant>) -> Result<(), PublisherError> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(error("GitHub discovery verification deadline exceeded"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    fn serve(response: &'static [u8]) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0_u8; 4096];
            let count = stream.read(&mut bytes).unwrap();
            stream.write_all(response).unwrap();
            String::from_utf8_lossy(&bytes[..count]).into_owned()
        });
        (format!("http://{address}"), handle)
    }

    #[test]
    fn asset_accept_replaces_json_without_mutating_json_requests() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 302 Found\r\nLocation: https://release-assets.githubusercontent.com/x\r\nContent-Length: 0\r\n\r\n".as_slice(),
        ] {
            let (base, observed) = serve(response);
            let mut requester = Requester::fixture("very-secret", base).unwrap();
            match requester.asset_response("/asset").unwrap() {
                AssetResponse::Bytes(response) => assert_eq!(response.bytes().unwrap(), "abc"),
                AssetResponse::Redirect(location) => {
                    assert_eq!(location, "https://release-assets.githubusercontent.com/x");
                }
            }
            let request = observed.join().unwrap();
            let accepts: Vec<_> = request
                .lines()
                .filter(|line| line.to_ascii_lowercase().starts_with("accept:"))
                .collect();
            assert_eq!(accepts, ["accept: application/octet-stream"]);
            assert!(!request.contains("application/vnd.github+json"));
            assert!(request.contains("accept-encoding: identity"));
            assert!(request.contains("authorization: Bearer very-secret"));
            assert!(request.contains(&format!("x-github-api-version: {API_VERSION}")));
            assert!(request.contains(&format!("user-agent: {USER_AGENT_VALUE}")));
            assert!(requester.headers[AUTHORIZATION].is_sensitive());

            let (base, observed) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            requester.base = base;
            requester.get_with_deadline::<serde_json::Value>("/json", None).unwrap();
            let request = observed.join().unwrap();
            let accepts: Vec<_> = request
                .lines()
                .filter(|line| line.to_ascii_lowercase().starts_with("accept:"))
                .collect();
            assert_eq!(accepts, ["accept: application/vnd.github+json"]);
            assert!(!request.contains("application/octet-stream"));
        }
    }

    #[test]
    fn authenticated_requests_are_manual_redirect_and_secret_safe() {
        let (base, observed) = serve(
            b"HTTP/1.1 302 Found\r\nLocation: https://release-assets.githubusercontent.com/x\r\nContent-Length: 0\r\n\r\n",
        );
        let requester = Requester::fixture("very-secret", base).unwrap();
        let AssetResponse::Redirect(location) = requester.asset_response("/asset").unwrap() else {
            panic!("expected redirect")
        };
        assert_eq!(location, "https://release-assets.githubusercontent.com/x");
        let request = observed.join().unwrap();
        assert!(request.contains("authorization: Bearer very-secret"));
        assert!(request.contains("accept-encoding: identity"));

        let (base, observed) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc");
        let requester = Requester::fixture("very-secret", base).unwrap();
        assert!(matches!(
            requester.asset_response("/asset").unwrap(),
            AssetResponse::Bytes(_)
        ));
        assert!(observed
            .join()
            .unwrap()
            .contains("authorization: Bearer very-secret"));

        let (base, _) = serve(b"HTTP/1.1 500 Nope\r\nContent-Length: 15\r\n\r\nvery-secret body");
        let error = Requester::fixture("very-secret", base)
            .unwrap()
            .get_with_deadline::<serde_json::Value>("/failure", None)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("very-secret"));
        assert!(!error.contains("body"));
        assert!(error.contains("500"));
    }

    #[test]
    fn json_is_status_and_size_bounded() {
        let oversized = MAX_JSON_BYTES + 1;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {oversized}\r\n\r\n");
        let leaked: &'static [u8] = Box::leak(response.into_bytes().into_boxed_slice());
        let (base, _) = serve(leaked);
        let error = Requester::fixture("token", base)
            .unwrap()
            .get_with_deadline::<serde_json::Value>("/large", None)
            .unwrap_err();
        assert!(error.to_string().contains("byte limit"));
    }
    use crate::github::fixture::{client, serve_json};
    use crate::github::ReleaseClient;

    #[test]
    fn publish_draft_uses_exact_patch_and_sanitizes_failure_response() {
        let release = r#"{"id":7,"draft":false,"prerelease":false,"tag_name":"v1","target_commitish":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":"notes"}"#;
        let (api, observed) = serve_json("200 OK", release);
        let published = client(api).publish_draft(7).unwrap();
        assert!(!published.draft);
        let request = observed.join().unwrap();
        assert!(request.starts_with("PATCH /repos/acme/releases/releases/7 HTTP/1.1"));
        assert!(request.contains("authorization: Bearer secret-token"));
        assert!(request.contains(r#"{"draft":false,"make_latest":"false"}"#));
        let (api, _) = serve_json("500 Nope", "secret-token remote body");
        let error = client(api).publish_draft(7).unwrap_err().to_string();
        assert!(!error.contains("secret-token"));
        assert!(!error.contains("remote body"));
        assert!(client("http://127.0.0.1:1".into())
            .publish_draft(0)
            .is_err());
    }
}
