use std::time::Duration;

use futures::StreamExt as _;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::super::remote::GitHubReleaseClient;
use super::API_VERSION;
use crate::error::AppError;

const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) struct Transport {
    client: reqwest::Client,
    api_base: String,
    upload_base: String,
}

impl Transport {
    pub(super) fn production(client: GitHubReleaseClient) -> Self {
        Self {
            client: client.http().clone(),
            api_base: "https://api.github.com".into(),
            upload_base: "https://uploads.github.com".into(),
        }
    }

    #[cfg(test)]
    pub(super) fn fixture(client: reqwest::Client, base: String) -> Self {
        Self {
            client,
            api_base: base.clone(),
            upload_base: base,
        }
    }

    pub(super) async fn get_json<T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<T, AppError> {
        self.json(Method::GET, token, path, Option::<&()>::None)
            .await
    }

    pub(super) async fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
        body: &B,
    ) -> Result<T, AppError> {
        self.json(Method::POST, token, path, Some(body)).await
    }

    pub(super) async fn patch_json<B: Serialize, T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
        body: &B,
    ) -> Result<T, AppError> {
        self.json(Method::PATCH, token, path, Some(body)).await
    }

    async fn json<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        token: &str,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, AppError> {
        let mut request = self.request(method, token, format!("{}{path}", self.api_base));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(transport_error)?;
        decode_json(response).await
    }

    pub(super) async fn upload(
        &self,
        token: &str,
        repository: &str,
        release_id: u64,
        name: &str,
        bytes: &axum::body::Bytes,
    ) -> Result<super::models::Asset, AppError> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/repos/{repository}/releases/{release_id}/assets",
            self.upload_base
        ))
        .map_err(|error| AppError::Internal(format!("build GitHub upload URL: {error}")))?;
        url.query_pairs_mut().append_pair("name", name);
        let response = self
            .request(Method::POST, token, url.to_string())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, bytes.len())
            .timeout(UPLOAD_TIMEOUT)
            .body(bytes.clone())
            .send()
            .await
            .map_err(transport_error)?;
        decode_json(response).await
    }

    fn request(&self, method: Method, token: &str, url: String) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("x-github-api-version", API_VERSION)
            .header(
                reqwest::header::USER_AGENT,
                concat!("Cadencr/", env!("CARGO_PKG_VERSION")),
            )
            .timeout(REQUEST_TIMEOUT)
    }
}

async fn decode_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, AppError> {
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_JSON_BYTES as u64)
    {
        return Err(remote_error("GitHub response exceeded 2 MiB"));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(transport_error)?;
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
            return Err(remote_error("GitHub response exceeded 2 MiB"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| remote_error("GitHub returned an invalid response"))
}

fn transport_error(error: reqwest::Error) -> AppError {
    remote_error(if error.is_timeout() {
        "GitHub request timed out; review the remote draft before retrying"
    } else {
        "GitHub request failed; review the remote draft before retrying"
    })
}

fn status_error(status: StatusCode) -> AppError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            AppError::BadRequest("GitHub rejected the connected account or permission".into())
        }
        StatusCode::NOT_FOUND => AppError::BadRequest("GitHub resource was not found".into()),
        StatusCode::TOO_MANY_REQUESTS => AppError::coded(
            StatusCode::TOO_MANY_REQUESTS,
            "PUBLICATION_RELEASE_RATE_LIMITED",
            "GitHub rate limited release publication; review the remote draft before retrying",
        ),
        _ => remote_error(&format!(
            "GitHub request failed with status {status}; review the remote draft before retrying"
        )),
    }
}

fn remote_error(message: &str) -> AppError {
    AppError::coded(
        StatusCode::BAD_GATEWAY,
        "PUBLICATION_RELEASE_REMOTE_FAILED",
        message,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Response, StatusCode};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    #[test]
    fn fixture_transport_uses_only_the_explicit_local_origin() {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let transport = Transport::fixture(client, "http://127.0.0.1:1234".into());
        assert_eq!(transport.api_base, "http://127.0.0.1:1234");
        assert_eq!(transport.upload_base, "http://127.0.0.1:1234");
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn redirects_are_not_followed_or_credentialed() {
        let hits = Arc::new(AtomicUsize::new(0));
        let target_hits = hits.clone();
        let target = serve(Router::new().route(
            "/stolen",
            get(move || async move {
                target_hits.fetch_add(1, Ordering::SeqCst);
                "{}"
            }),
        ))
        .await;
        let location = format!("{target}/stolen");
        let origin = serve(Router::new().route(
            "/redirect",
            get(move || {
                let location = location.clone();
                async move {
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header("location", location)
                        .body(Body::empty())
                        .unwrap()
                }
            }),
        ))
        .await;
        let transport = Transport::fixture(client(), origin);
        assert!(transport
            .get_json::<serde_json::Value>("top-secret", "/redirect")
            .await
            .is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn oversized_and_malformed_json_are_sanitized_failures() {
        let oversized = vec![b' '; MAX_JSON_BYTES + 1];
        let origin = serve(
            Router::new()
                .route(
                    "/oversized",
                    get(move || {
                        let oversized = oversized.clone();
                        async move { oversized }
                    }),
                )
                .route("/malformed", get(|| async { "not-json" })),
        )
        .await;
        let transport = Transport::fixture(client(), origin);
        for path in ["/oversized", "/malformed"] {
            let error = transport
                .get_json::<serde_json::Value>("top-secret", path)
                .await
                .unwrap_err();
            let rendered = error.to_string();
            assert!(!rendered.contains("top-secret"));
            assert!(!rendered.contains("not-json"));
        }
    }
}
