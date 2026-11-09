//! The egress relay (`docs/CUSTOM_TABS.md` §4.5): a guest has no network of
//! its own, so `net.fetch` lands here and goes out only to the manifest's
//! `network.allowed_origins`.
//!
//! Bytes travel raw both ways — the request body is the upstream body and the
//! upstream answer comes back as this response's body, its status and headers
//! in `x-cadencr-net-*` headers — so nobody base64-encodes or JSON-parses a
//! payload. Redirects are followed by hand so every hop is checked against the
//! allow list, each hop's DNS answer is pinned and must be public unless the
//! origin is literally `localhost`/`127.0.0.1`, and secrets are substituted
//! server-side and never reach the guest.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use cadencr_plugin_core::tab::TabManifest;
use reqwest::header::{HeaderName, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Method, Url};
use sqlx::SqlitePool;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::config;
use super::principal::PluginPrincipal;
use crate::error::AppError;
use crate::shared::http_relay::{self, PinError, ReadError};

mod headers;

pub const MAX_REDIRECTS: usize = 5;
pub const TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 10 * 1024 * 1024;
/// Requests one plugin may have in flight; each can buffer a full response.
pub const MAX_CONCURRENT: usize = 4;

/// Request: the outbound headers as a JSON object (optional). Response: the
/// upstream's filtered headers, same shape.
pub const NET_HEADERS_HEADER: &str = "x-cadencr-net-headers";
/// Response: the upstream status. Absent on a relay failure (`{error, code}`).
pub const NET_STATUS_HEADER: &str = "x-cadencr-net-status";
const MAX_HEADERS_JSON_BYTES: usize = 16 * 1024;

/// Hosts an origin may name to reach this machine (`http` is only accepted
/// for these, see plugin-core's network rules).
const LOOPBACK_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

/// One relay request, as decoded from the route.
pub struct RelayRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub body: Bytes,
}

/// What the upstream answered, whatever its status.
pub struct Relayed {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl IntoResponse for Relayed {
    fn into_response(self) -> Response {
        // `inbound` keeps only visible-ASCII values, so the JSON is a valid
        // header value; failing that is a bug, reported as such.
        let headers = serde_json::to_string(&self.headers)
            .map_err(|error| error.to_string())
            .and_then(|json| HeaderValue::from_str(&json).map_err(|error| error.to_string()));
        match headers {
            Ok(headers) => (
                [
                    (
                        HeaderName::from_static(NET_STATUS_HEADER),
                        HeaderValue::from(self.status),
                    ),
                    (HeaderName::from_static(NET_HEADERS_HEADER), headers),
                    (
                        CONTENT_TYPE,
                        HeaderValue::from_static("application/octet-stream"),
                    ),
                ],
                self.body,
            )
                .into_response(),
            Err(error) => AppError::internal(format!("relayed headers: {error}")).into_response(),
        }
    }
}

/// The outbound headers from `x-cadencr-net-headers`: a JSON object of
/// strings (ASCII; escape anything else as `\uXXXX`), ≤ 16 KiB.
pub fn request_headers(headers: &HeaderMap) -> Result<BTreeMap<String, String>, AppError> {
    let Some(value) = headers.get(NET_HEADERS_HEADER) else {
        return Ok(BTreeMap::new());
    };
    if value.len() > MAX_HEADERS_JSON_BYTES {
        return Err(AppError::BadRequest(format!(
            "`{NET_HEADERS_HEADER}` is capped at {} KiB",
            MAX_HEADERS_JSON_BYTES / 1024
        )));
    }
    let text = value
        .to_str()
        .map_err(|_| AppError::BadRequest(format!("`{NET_HEADERS_HEADER}` must be ASCII JSON")))?;
    serde_json::from_str(text).map_err(|error| {
        AppError::BadRequest(format!(
            "`{NET_HEADERS_HEADER}` must be a JSON object of strings: {error}"
        ))
    })
}

/// One outbound request as it moves through redirects.
struct Hop {
    method: Method,
    url: Url,
    headers: HeaderMap,
    secret_headers: Vec<HeaderName>,
    body: Option<Bytes>,
}

/// Relay `request` for the plugin of `principal`.
pub async fn fetch(
    pool: &SqlitePool,
    principal: &PluginPrincipal,
    manifest: &TabManifest,
    request: RelayRequest,
) -> Result<Relayed, AppError> {
    let _permit = acquire(&principal.plugin_id)?;
    let allowed = manifest.allowed_origins();
    let url = Url::parse(&request.url)
        .map_err(|error| AppError::BadRequest(format!("`url` is not an absolute URL: {error}")))?;
    require_allowed(&url, allowed)?;
    let method = parse_method(request.method.as_deref())?;
    let secrets = resolve_secrets(pool, principal, manifest, &request.headers).await?;
    let (headers, secret_headers) = headers::outbound(&request.headers, &secrets)?;
    let hop = Hop {
        method,
        url,
        headers,
        secret_headers,
        body: (!request.body.is_empty()).then_some(request.body),
    };
    tokio::time::timeout(TIMEOUT, follow(hop, allowed))
        .await
        .map_err(|_| {
            AppError::coded(
                StatusCode::GATEWAY_TIMEOUT,
                "PLUGIN_NETWORK_TIMEOUT",
                format!("the request did not complete within {}s", TIMEOUT.as_secs()),
            )
        })?
}

/// A slot among the plugin's [`MAX_CONCURRENT`] relays, or 429
/// `PLUGIN_NETWORK_BUSY`.
fn acquire(plugin_id: &str) -> Result<OwnedSemaphorePermit, AppError> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Arc<Semaphore>>>> = OnceLock::new();
    let semaphore = SLOTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(plugin_id.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT)))
        .clone();
    semaphore.try_acquire_owned().map_err(|_| {
        AppError::coded(
            StatusCode::TOO_MANY_REQUESTS,
            "PLUGIN_NETWORK_BUSY",
            format!("at most {MAX_CONCURRENT} net.fetch requests at a time"),
        )
    })
}

/// The plaintext of every secret the headers reference; 400
/// `PLUGIN_TAB_SECRET_UNKNOWN` for one that is not a set, declared secret.
async fn resolve_secrets(
    pool: &SqlitePool,
    principal: &PluginPrincipal,
    manifest: &TabManifest,
    headers: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, AppError> {
    let mut secrets = BTreeMap::new();
    for key in headers
        .values()
        .flat_map(|value| headers::secret_keys(value))
    {
        if secrets.contains_key(key) {
            continue;
        }
        let value = config::secret_value(
            pool,
            &principal.plugin_id,
            manifest,
            principal.project_id,
            key,
        )
        .await?
        .ok_or_else(|| {
            AppError::coded(
                StatusCode::BAD_REQUEST,
                "PLUGIN_TAB_SECRET_UNKNOWN",
                format!("`{key}` is not a declared secret with a value"),
            )
        })?;
        secrets.insert(key.to_string(), value);
    }
    Ok(secrets)
}

async fn follow(mut hop: Hop, allowed: &[String]) -> Result<Relayed, AppError> {
    for redirects in 0..=MAX_REDIRECTS {
        let mut builder = client(&hop.url)
            .await?
            .request(hop.method.clone(), hop.url.clone())
            .headers(hop.headers.clone());
        if let Some(body) = &hop.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.map_err(upstream_failed)?;
        let Some(next) = http_relay::redirect_target(&response, &hop.url)
            .map_err(|reason| upstream_failed_message(format!("the upstream {reason}")))?
        else {
            return read_response(response).await;
        };
        if redirects == MAX_REDIRECTS {
            break;
        }
        let status = response.status();
        // Never drain a redirect body: it can be arbitrarily large.
        drop(response);
        require_allowed(&next, allowed)?;
        redirect(&mut hop, status, next);
    }
    Err(AppError::coded(
        StatusCode::BAD_GATEWAY,
        "PLUGIN_NETWORK_TOO_MANY_REDIRECTS",
        format!("more than {MAX_REDIRECTS} redirects"),
    ))
}

/// Move `hop` to `next` the way browsers do: 303 (and 301/302 after a POST)
/// become a body-less GET; credentials never cross to another origin.
fn redirect(hop: &mut Hop, status: StatusCode, next: Url) {
    let to_get = status == StatusCode::SEE_OTHER
        || (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
            && hop.method == Method::POST);
    if to_get {
        hop.method = Method::GET;
        hop.body = None;
        hop.headers.remove(CONTENT_TYPE);
    }
    if next.origin() != hop.url.origin() {
        hop.headers.remove(AUTHORIZATION);
        for name in &hop.secret_headers {
            hop.headers.remove(name);
        }
    }
    hop.url = next;
}

/// A client pinned to this hop's checked addresses: no redirects (followed by
/// hand), no cookies, no proxy. Private addresses are refused unless the
/// origin names this machine literally (a local dev server the user consented
/// to); a public name that resolves privately is DNS rebinding.
async fn client(url: &Url) -> Result<reqwest::Client, AppError> {
    let builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Cadencr-Tab-Relay/", env!("CARGO_PKG_VERSION")));
    let loopback = url
        .host_str()
        .is_some_and(|host| LOOPBACK_HOSTS.contains(&host));
    http_relay::pinned_client(builder, url, loopback)
        .await
        .map_err(|error| match error {
            PinError::Private(address) => AppError::coded(
                StatusCode::FORBIDDEN,
                "PLUGIN_NETWORK_DENIED",
                format!(
                    "`{}` resolves to the non-public address {address}",
                    url.host_str().unwrap_or_default()
                ),
            ),
            PinError::MissingHost => upstream_failed_message("the URL has no host".into()),
            PinError::Resolve(reason) => upstream_failed_message(format!("DNS: {reason}")),
            PinError::NoAddress => upstream_failed_message("the host has no address".into()),
            PinError::Build(error) => AppError::internal(format!("relay client: {error}")),
        })
}

/// Read the body with the 10 MiB cap enforced while streaming.
async fn read_response(response: reqwest::Response) -> Result<Relayed, AppError> {
    let status = response.status().as_u16();
    let headers = headers::inbound(response.headers());
    let body = http_relay::read_capped(response, MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| match error {
            ReadError::TooLarge => too_large(),
            ReadError::Body(error) => upstream_failed(error),
        })?;
    Ok(Relayed {
        status,
        headers,
        body,
    })
}

/// 403 `PLUGIN_NETWORK_DENIED` unless `url`'s origin is declared. URLs with
/// credentials are refused: the origin check ignores them, the request would not.
fn require_allowed(url: &Url, allowed: &[String]) -> Result<(), AppError> {
    let origin = url.origin().ascii_serialization();
    let has_credentials = !url.username().is_empty() || url.password().is_some();
    if !has_credentials && allowed.contains(&origin) {
        return Ok(());
    }
    Err(AppError::coded(
        StatusCode::FORBIDDEN,
        "PLUGIN_NETWORK_DENIED",
        format!("`{origin}` is not in this tab's network.allowed_origins"),
    ))
}

fn parse_method(method: Option<&str>) -> Result<Method, AppError> {
    Ok(
        match method.unwrap_or("GET").to_ascii_uppercase().as_str() {
            "GET" => Method::GET,
            "HEAD" => Method::HEAD,
            "POST" => Method::POST,
            "PUT" => Method::PUT,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            "OPTIONS" => Method::OPTIONS,
            other => {
                return Err(AppError::BadRequest(format!(
                    "unsupported method `{other}`"
                )))
            }
        },
    )
}

fn too_large() -> AppError {
    AppError::coded(
        StatusCode::BAD_GATEWAY,
        "PLUGIN_NETWORK_RESPONSE_TOO_LARGE",
        format!(
            "responses are capped at {} MiB",
            MAX_RESPONSE_BYTES / (1024 * 1024)
        ),
    )
}

fn upstream_failed(error: reqwest::Error) -> AppError {
    upstream_failed_message(error.to_string())
}

fn upstream_failed_message(message: String) -> AppError {
    AppError::coded(StatusCode::BAD_GATEWAY, "PLUGIN_NETWORK_FAILED", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> Vec<String> {
        vec!["https://api.example".into(), "http://127.0.0.1:9".into()]
    }

    #[test]
    fn only_declared_origins_without_credentials_pass() {
        let check = |url: &str| require_allowed(&Url::parse(url).unwrap(), &allowed()).is_ok();
        assert!(check("https://api.example/v1/x?y=1"));
        assert!(check("https://api.example:443/"));
        assert!(check("http://127.0.0.1:9/"));
        assert!(!check("http://api.example/"));
        assert!(!check("https://api.example.evil/"));
        assert!(!check("https://user:pw@api.example/"));
        assert!(!check("http://127.0.0.1:10/"));
        assert!(!check("file:///etc/passwd"));
    }

    #[test]
    fn methods_are_restricted() {
        assert_eq!(parse_method(None).unwrap(), Method::GET);
        assert_eq!(parse_method(Some("post")).unwrap(), Method::POST);
        assert!(parse_method(Some("CONNECT")).is_err());
        assert!(parse_method(Some("TRACE")).is_err());
    }

    #[test]
    fn redirects_downgrade_to_get_and_drop_credentials_across_origins() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer x".parse().unwrap());
        headers.insert("x-api-key", "k".parse().unwrap());
        headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
        let mut hop = Hop {
            method: Method::POST,
            url: Url::parse("https://api.example/a").unwrap(),
            headers,
            secret_headers: vec![HeaderName::from_static("x-api-key")],
            body: Some(Bytes::from_static(b"{}")),
        };
        redirect(
            &mut hop,
            StatusCode::TEMPORARY_REDIRECT,
            Url::parse("https://api.example/b").unwrap(),
        );
        assert_eq!(hop.method, Method::POST);
        assert!(hop.body.is_some() && hop.headers.contains_key(AUTHORIZATION));
        redirect(
            &mut hop,
            StatusCode::FOUND,
            Url::parse("http://127.0.0.1:9/c").unwrap(),
        );
        assert_eq!(hop.method, Method::GET);
        assert!(hop.body.is_none());
        assert!(hop.headers.is_empty(), "{:?}", hop.headers);
    }

    #[test]
    fn request_headers_come_from_one_json_header() {
        let mut headers = HeaderMap::new();
        assert!(request_headers(&headers).unwrap().is_empty());
        headers.insert(
            NET_HEADERS_HEADER,
            HeaderValue::from_static(r#"{"Accept":"application/json","X-Name":"caf\u00e9"}"#),
        );
        let parsed = request_headers(&headers).unwrap();
        assert_eq!(parsed["Accept"], "application/json");
        assert_eq!(parsed["X-Name"], "café");
        for bad in [r#"["a"]"#, r#"{"a":1}"#, "nope"] {
            headers.insert(NET_HEADERS_HEADER, HeaderValue::from_static(bad));
            assert!(request_headers(&headers).is_err(), "{bad}");
        }
        let huge = format!(r#"{{"a":"{}"}}"#, "x".repeat(MAX_HEADERS_JSON_BYTES));
        headers.insert(NET_HEADERS_HEADER, HeaderValue::from_str(&huge).unwrap());
        assert!(request_headers(&headers).is_err());
    }

    #[tokio::test]
    async fn the_upstream_answer_travels_in_headers_and_a_raw_body() {
        let relayed = Relayed {
            status: 404,
            headers: BTreeMap::from([("content-type".to_string(), "text/plain".to_string())]),
            body: vec![0, 159, 146, 150],
        };
        let response = relayed.into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[NET_STATUS_HEADER], "404");
        assert_eq!(
            response.headers()[NET_HEADERS_HEADER],
            r#"{"content-type":"text/plain"}"#
        );
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], [0, 159, 146, 150]);
    }

    #[tokio::test]
    async fn hops_to_private_addresses_are_refused_unless_the_origin_is_loopback() {
        let code = |result: Result<reqwest::Client, AppError>| match result {
            Ok(_) => "OK",
            Err(AppError::Coded { code, .. }) => code,
            Err(other) => panic!("unexpected {other:?}"),
        };
        let pin = |url: &str| {
            let url = Url::parse(url).unwrap();
            async move { client(&url).await }
        };
        assert_eq!(code(pin("http://127.0.0.1:9/").await), "OK");
        assert_eq!(code(pin("http://localhost:9/").await), "OK");
        assert_eq!(
            code(pin("https://10.0.0.1/").await),
            "PLUGIN_NETWORK_DENIED"
        );
        assert_eq!(code(pin("https://[::1]/").await), "PLUGIN_NETWORK_DENIED");
    }

    #[test]
    fn each_plugin_gets_a_bounded_number_of_relays() {
        let held: Vec<_> = (0..MAX_CONCURRENT)
            .map(|_| acquire("busy-plugin").unwrap())
            .collect();
        assert!(matches!(
            acquire("busy-plugin"),
            Err(AppError::Coded {
                code: "PLUGIN_NETWORK_BUSY",
                ..
            })
        ));
        assert!(acquire("other-plugin").is_ok());
        drop(held);
        assert!(acquire("busy-plugin").is_ok());
    }
}
