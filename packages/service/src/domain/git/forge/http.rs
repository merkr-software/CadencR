use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::time::{Duration, Instant};

use reqwest::header::{ETAG, IF_NONE_MATCH};
use reqwest::{RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

mod mutation;
mod rate_limit;

use self::rate_limit::{is_secondary_rate_limit, rate_limit_wait, DEFAULT_RATE_LIMIT_WAIT};
use super::provider::ForgeError;

#[derive(Clone)]
struct CachedResponse {
    etag: String,
    body: Vec<u8>,
}

const MAX_ETAG_ENTRIES: usize = 512;

/// Shared forge HTTP transport.
///
/// Adapters own endpoint/auth-header details; this type owns the cross-provider
/// operational policy: conditional GETs, response-body reuse for `304`, and
/// host-scoped rate-limit backoff.
pub struct ForgeHttp {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, CachedResponse>>,
    backoff_until: Mutex<HashMap<String, Instant>>,
}

impl Default for ForgeHttp {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            // Provider credentials use both standard and custom headers. Never
            // let reqwest forward them to a redirect target; forge endpoints
            // must remain on the HTTPS, host-bound API URL we validated.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Cadencr/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("static forge HTTP client configuration should be valid");
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
            backoff_until: Mutex::new(HashMap::new()),
        }
    }
}

impl ForgeHttp {
    pub fn get(&self, url: &str) -> RequestBuilder {
        self.client.get(url)
    }

    pub fn post(&self, url: &str) -> RequestBuilder {
        self.client.post(url)
    }

    /// Executes a forge request and decodes its JSON response. The request
    /// builder owns the HTTP method, so REST GETs and GraphQL POSTs share the
    /// same rate-limit, error, and conditional-response policy.
    pub async fn request_json<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder,
    ) -> Result<T, ForgeError> {
        self.execute_json(builder).await
    }

    async fn execute_json<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder,
    ) -> Result<T, ForgeError> {
        let mut request = builder
            .build()
            .map_err(|error| ForgeError::Http(format!("invalid forge request: {error}")))?;
        // Conditional responses must never cross authentication contexts. In
        // particular, `/user` often emits ETags: keying by URL alone could make
        // a newly-entered token validate as the previously-connected account.
        let cache_key = response_cache_key(&request);
        let host = request.url().host_str().unwrap_or("forge").to_string();
        self.check_backoff(&host).await?;

        if let Some(cached) = self.cache.lock().await.get(&cache_key).cloned() {
            let value = reqwest::header::HeaderValue::from_str(&cached.etag)
                .map_err(|error| ForgeError::Http(format!("invalid cached ETag: {error}")))?;
            request.headers_mut().insert(IF_NONE_MATCH, value);
        }

        let response = self.send_checked(request, host).await?;
        let status = response.status();
        if status == StatusCode::NOT_MODIFIED {
            let cached = self
                .cache
                .lock()
                .await
                .get(&cache_key)
                .cloned()
                .ok_or_else(|| {
                    ForgeError::Response("forge returned 304 without a cached response".into())
                })?;
            return serde_json::from_slice(&cached.body).map_err(|error| {
                ForgeError::Response(format!("cached forge response was invalid: {error}"))
            });
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ForgeError::Http(request_failure_message(status, &body)));
        }

        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response
            .bytes()
            .await
            .map_err(|error| ForgeError::Http(format!("failed reading forge response: {error}")))?
            .to_vec();
        if let Some(etag) = etag {
            let mut cache = self.cache.lock().await;
            if cache.len() >= MAX_ETAG_ENTRIES {
                if let Some(victim) = cache.keys().next().cloned() {
                    cache.remove(&victim);
                }
            }
            cache.insert(
                cache_key,
                CachedResponse {
                    etag,
                    body: body.clone(),
                },
            );
        }
        serde_json::from_slice(&body)
            .map_err(|error| ForgeError::Response(format!("invalid forge response: {error}")))
    }

    /// Decide what a `403` actually means. GitHub answers a throttled request
    /// with `403` as readily as with `429`, so a forbidden response is only an
    /// auth problem once every rate-limit signal has been ruled out — otherwise
    /// a throttled poll sends the user off to re-authenticate a working token.
    /// Sends one request under the shared rate-limit and authentication
    /// policy. The backoff check is the caller's: it comes before any cache
    /// lookup. Every other status is the caller's to interpret.
    async fn send_checked(
        &self,
        request: reqwest::Request,
        host: String,
    ) -> Result<reqwest::Response, ForgeError> {
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|error| ForgeError::Http(format!("forge request failed: {error}")))?;
        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => {
                let wait = rate_limit_wait(&response).unwrap_or(DEFAULT_RATE_LIMIT_WAIT);
                Err(self.arm_backoff(host, wait).await)
            }
            StatusCode::UNAUTHORIZED => Err(ForgeError::Authentication(
                "Forge rejected the configured token".into(),
            )),
            StatusCode::FORBIDDEN => Err(self.classify_forbidden(host, response).await),
            _ => Ok(response),
        }
    }

    async fn classify_forbidden(&self, host: String, response: reqwest::Response) -> ForgeError {
        if let Some(wait) = rate_limit_wait(&response) {
            return self.arm_backoff(host, wait).await;
        }
        let status = response.status();
        // Truncate before inspecting: a proxy or WAF can answer 403 with a page
        // of HTML, and the two reads below would each copy the whole thing.
        let detail = truncated_detail(&response.text().await.unwrap_or_default());
        if is_secondary_rate_limit(&detail) {
            // A secondary limit carries no reset header, so the body is the only
            // signal. GitHub's guidance is to wait at least a minute — the default.
            return self.arm_backoff(host, DEFAULT_RATE_LIMIT_WAIT).await;
        }
        ForgeError::Authentication(request_failure_message(status, &detail))
    }

    /// Pause every request to `host` until the forge says it will listen again.
    async fn arm_backoff(&self, host: String, wait: Duration) -> ForgeError {
        self.backoff_until
            .lock()
            .await
            .insert(host, Instant::now() + wait);
        ForgeError::RateLimited(format!(
            "Forge rate limit reached; retrying in {}s",
            wait.as_secs()
        ))
    }

    async fn check_backoff(&self, host: &str) -> Result<(), ForgeError> {
        let mut backoff = self.backoff_until.lock().await;
        let Some(until) = backoff.get(host).copied() else {
            return Ok(());
        };
        let now = Instant::now();
        if now >= until {
            backoff.remove(host);
            return Ok(());
        }
        // Deliberately no countdown. This string reaches the sidebar through a
        // snapshot, and `PrStatusSnapshot::semantic_eq` compares it verbatim, so
        // a decrementing number would make every poll look like fresh news and
        // rebroadcast to every client for the length of the pause.
        tracing::debug!(
            host,
            seconds_left = until.saturating_duration_since(now).as_secs(),
            "forge host is paused"
        );
        Err(ForgeError::RateLimited(format!(
            "Forge requests for {host} are paused until the rate limit resets"
        )))
    }
}

fn response_cache_key(request: &reqwest::Request) -> String {
    let mut hasher = DefaultHasher::new();
    for (name, value) in request.headers() {
        name.as_str().hash(&mut hasher);
        value.as_bytes().hash(&mut hasher);
    }
    format!("{}#{:016x}", request.url(), hasher.finish())
}

/// As much of a response body as is worth quoting back to the user. Forges
/// answer with anything from a one-line JSON message to a full HTML page.
fn truncated_detail(body: &str) -> String {
    body.chars().take(500).collect()
}

fn request_failure_message(status: StatusCode, body: &str) -> String {
    let detail = truncated_detail(body);
    if detail.trim().is_empty() {
        format!("Forge request failed with HTTP {status}")
    } else {
        format!("Forge request failed with HTTP {status}: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::rate_limit::test_response;
    use super::*;

    async fn classify(headers: &[(&str, &str)], body: &str) -> ForgeError {
        ForgeHttp::default()
            .classify_forbidden("forge.test".into(), test_response(403, headers, body))
            .await
    }

    #[tokio::test]
    async fn a_throttled_403_never_asks_the_user_to_reconnect() {
        // The bug this covers: GitHub answers a secondary rate limit with 403
        // and a `retry-after`, but leaves the hourly quota untouched. Reading
        // only `x-ratelimit-remaining` classified that as an auth failure —
        // which `is_setup_failure` turns into the "Connect this remote" prompt,
        // telling the user to re-authenticate a perfectly good token.
        let error = classify(&[("retry-after", "30")], "secondary rate limit").await;

        assert_eq!(
            error,
            ForgeError::RateLimited("Forge rate limit reached; retrying in 30s".into())
        );
        assert!(!error.is_setup_failure());
    }

    #[tokio::test]
    async fn a_secondary_limit_with_no_headers_is_read_from_the_body() {
        for body in [
            "You have exceeded a secondary rate limit. Please wait a few minutes.",
            "You have triggered an abuse detection mechanism.",
        ] {
            let error = classify(&[], body).await;
            assert!(!error.is_setup_failure(), "{body}");
            assert!(
                matches!(&error, ForgeError::RateLimited(message) if message.contains("60s")),
                "{body} produced {error:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_exhausted_quota_still_backs_off_until_the_reset() {
        let reset = chrono::Utc::now().timestamp() + 120;
        let error = classify(
            &[
                ("x-ratelimit-remaining", "0"),
                ("x-ratelimit-reset", &reset.to_string()),
            ],
            "API rate limit exceeded",
        )
        .await;

        // The exact wait is asserted in `rate_limit`'s own tests, which own the
        // clock arithmetic; pinning the number here too would just make this
        // test fail whenever it straddles a second boundary.
        assert!(matches!(error, ForgeError::RateLimited(_)), "{error:?}");
        assert!(!error.is_setup_failure());
    }

    #[tokio::test]
    async fn a_real_permission_failure_is_still_a_setup_failure() {
        // The other half of the fix: narrowing the rate-limit test must not
        // swallow the case the 403 branch exists for. A token missing a scope
        // has to keep reaching the onboarding prompt.
        let error = classify(&[], "Resource not accessible by personal access token").await;

        assert!(error.is_setup_failure());
        assert!(
            matches!(&error, ForgeError::Authentication(message)
                if message.contains("Resource not accessible")),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_rate_limited_host_is_paused_without_another_request() {
        let http = ForgeHttp::default();
        let error = http
            .classify_forbidden(
                "paused.test".into(),
                test_response(403, &[("retry-after", "45")], ""),
            )
            .await;

        assert!(matches!(error, ForgeError::RateLimited(_)));
        // The pause is the point: the next poll has to be refused locally
        // rather than spending another request on a host that is refusing us.
        assert!(matches!(
            http.check_backoff("paused.test").await,
            Err(ForgeError::RateLimited(_))
        ));
        assert!(http.check_backoff("other.test").await.is_ok());
    }
}
