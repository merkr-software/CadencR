use std::time::Duration;

use futures::StreamExt as _;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::AppError;

const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;

pub(super) enum Optional<T> {
    Found(T),
    Missing,
}

pub(super) struct Transport {
    client: reqwest::Client,
    base: String,
}

impl Transport {
    pub(super) fn production() -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| {
                AppError::Internal(format!("build GitHub registry client: {error}"))
            })?;
        Ok(Self {
            client,
            base: "https://api.github.com".into(),
        })
    }

    #[cfg(test)]
    pub(super) fn fixture(client: reqwest::Client, base: String) -> Self {
        Self { client, base }
    }

    pub(super) async fn get<T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<T, AppError> {
        match self
            .send::<(), T>(Method::GET, token, path, None, false)
            .await?
        {
            Optional::Found(value) => Ok(value),
            Optional::Missing => Err(remote("GitHub resource disappeared")),
        }
    }

    pub(super) async fn get_optional<T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<Option<T>, AppError> {
        Ok(
            match self
                .send::<(), T>(Method::GET, token, path, None, true)
                .await?
            {
                Optional::Found(value) => Some(value),
                Optional::Missing => None,
            },
        )
    }

    pub(super) async fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
        body: &B,
    ) -> Result<T, AppError> {
        match self
            .send(Method::POST, token, path, Some(body), false)
            .await?
        {
            Optional::Found(value) => Ok(value),
            Optional::Missing => Err(remote("GitHub mutation target disappeared")),
        }
    }

    async fn send<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        token: &str,
        path: &str,
        body: Option<&B>,
        missing_ok: bool,
    ) -> Result<Optional<T>, AppError> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("x-github-api-version", "2026-03-10")
            .header(
                reqwest::header::USER_AGENT,
                concat!("Cadencr/", env!("CARGO_PKG_VERSION")),
            )
            .timeout(Duration::from_secs(30));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(network_error)?;
        if missing_ok && response.status() == StatusCode::NOT_FOUND {
            return Ok(Optional::Missing);
        }
        decode(response).await.map(Optional::Found)
    }
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, AppError> {
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status, response.headers()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_JSON_BYTES as u64)
    {
        return Err(remote("GitHub response exceeded 2 MiB"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
            return Err(remote("GitHub response exceeded 2 MiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| remote("GitHub returned an invalid response"))
}

fn status_error(status: StatusCode, headers: &reqwest::header::HeaderMap) -> AppError {
    if status == StatusCode::TOO_MANY_REQUESTS
        || (status == StatusCode::FORBIDDEN
            && (headers
                .get("x-ratelimit-remaining")
                .is_some_and(|value| value == "0")
                || headers.contains_key(reqwest::header::RETRY_AFTER)))
    {
        return AppError::coded(
            StatusCode::TOO_MANY_REQUESTS,
            "PUBLICATION_REGISTRY_RATE_LIMITED",
            "GitHub rate limited registry submission; wait before inspecting the fork and retrying",
        );
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => AppError::coded(
            StatusCode::BAD_REQUEST,
            "PUBLICATION_REGISTRY_AUTH_REJECTED",
            "GitHub rejected the connected account or permission",
        ),
        StatusCode::CONFLICT | StatusCode::UNPROCESSABLE_ENTITY => super::conflict(
            "PUBLICATION_REGISTRY_REMOTE_CONFLICT",
            "GitHub rejected a registry write; inspect the fork before retrying",
        ),
        _ => remote(&format!(
            "GitHub request failed with status {status}; inspect the fork before retrying"
        )),
    }
}

fn network_error(error: reqwest::Error) -> AppError {
    remote(if error.is_timeout() {
        "GitHub request timed out; inspect the fork before retrying"
    } else {
        "GitHub request failed; inspect the fork before retrying"
    })
}

fn remote(message: &str) -> AppError {
    AppError::coded(
        StatusCode::BAD_GATEWAY,
        "PUBLICATION_REGISTRY_REMOTE_FAILED",
        message,
    )
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Response, StatusCode};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    async fn server(app: Router) -> String {
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
    async fn refuses_redirects_and_bounded_invalid_responses() {
        let origin = server(
            Router::new()
                .route(
                    "/redirect",
                    get(|| async {
                        Response::builder()
                            .status(StatusCode::FOUND)
                            .header("location", "http://127.0.0.1:1/stolen")
                            .body(Body::empty())
                            .unwrap()
                    }),
                )
                .route("/malformed", get(|| async { "not-json" }))
                .route(
                    "/oversized",
                    get(|| async { vec![b' '; MAX_JSON_BYTES + 1] }),
                ),
        )
        .await;
        let transport = Transport::fixture(client(), origin);
        for path in ["/redirect", "/malformed", "/oversized"] {
            let rendered = transport
                .get::<serde_json::Value>("secret-token", path)
                .await
                .unwrap_err()
                .to_string();
            assert!(!rendered.contains("secret-token"));
            assert!(!rendered.contains("not-json"));
        }
    }
    #[test]
    fn distinguishes_permission_rejection_from_rate_limits_without_response_bodies() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(status_error(StatusCode::FORBIDDEN, &headers)
            .to_string()
            .contains("permission"));
        assert!(status_error(StatusCode::TOO_MANY_REQUESTS, &headers)
            .to_string()
            .contains("rate limited"));
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        assert!(status_error(StatusCode::FORBIDDEN, &headers)
            .to_string()
            .contains("rate limited"));
        headers.clear();
        headers.insert(reqwest::header::RETRY_AFTER, "60".parse().unwrap());
        assert!(status_error(StatusCode::FORBIDDEN, &headers)
            .to_string()
            .contains("rate limited"));
    }
}
