//! A blocking client for the Cadencr API (feature `api`).
//!
//! It authenticates with the backend's own grant from `hello.api` — the
//! tab's consented scopes, bound to its conversation — and decodes Cadencr's
//! `{error, code}` error shape into [`ApiError`]. Inside a handler, use
//! [`Context::api`](crate::Context::api).
//!
//! The token only ever goes to Cadencr on this machine: the client refuses a
//! `base_url` that is not plain `http://` to a loopback address, and never
//! uses a proxy (`HTTP_PROXY`, `ALL_PROXY`… are ignored), so the grant cannot
//! leak to a proxy or another host.

use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use reqwest::blocking::{Client, RequestBuilder};
use reqwest::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Method, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::protocol::ApiInfo;

/// Upper bound on one API call.
const TIMEOUT: Duration = Duration::from_secs(30);

/// Codes of failures that happen before Cadencr answers.
pub mod codes {
    /// The request could not be sent or its answer not read.
    pub const API_UNREACHABLE: &str = "API_UNREACHABLE";
    /// Cadencr answered with something that is not the expected JSON.
    pub const API_BAD_RESPONSE: &str = "API_BAD_RESPONSE";
    /// The client could not be set up from `hello.api`.
    pub const API_INVALID_CONFIG: &str = "API_INVALID_CONFIG";
    /// The request body could not be encoded as JSON.
    pub const API_INVALID_BODY: &str = "API_INVALID_BODY";
}

/// A failed API call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    /// The HTTP status, when Cadencr answered.
    pub status: Option<u16>,
    /// Cadencr's stable code (e.g. `PLUGIN_SCOPE_DENIED`), or one of
    /// [`codes`].
    pub code: String,
    pub message: String,
}

impl ApiError {
    fn local(code: &str, message: impl fmt::Display) -> Self {
        Self {
            status: None,
            code: code.into(),
            message: message.to_string(),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "{} ({status}): {}", self.code, self.message),
            None => write!(formatter, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for ApiError {}

/// Passed through as is, so `cx.api()?.get(..)?` reports Cadencr's code.
impl From<ApiError> for Error {
    fn from(error: ApiError) -> Self {
        Error::new(error.code, error.message)
    }
}

/// Cadencr's error body.
#[derive(Deserialize)]
struct ErrorShape {
    error: String,
    code: String,
}

/// A client bound to one backend's `hello.api`.
#[derive(Debug, Clone)]
pub struct Api {
    client: Client,
    base_url: String,
    header: HeaderName,
    token: HeaderValue,
}

impl Api {
    pub fn new(info: &ApiInfo) -> Result<Self, ApiError> {
        let invalid = |error: &dyn fmt::Display| ApiError::local(codes::API_INVALID_CONFIG, error);
        let header = HeaderName::from_bytes(info.token_header.as_bytes())
            .map_err(|error| invalid(&error))?;
        let mut token = HeaderValue::from_str(&info.token).map_err(|error| invalid(&error))?;
        token.set_sensitive(true);
        let base_url = loopback_base_url(&info.base_url)?;
        let client = Client::builder()
            .timeout(TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|error| invalid(&error))?;
        Ok(Self {
            client,
            base_url,
            header,
            token,
        })
    }

    /// `GET {base_url}{path}`; `path` starts with `/`, e.g. `/api/...`.
    pub fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        self.send(self.request(Method::GET, path))
    }

    /// `POST` with a JSON body.
    pub fn post<B, T>(&self, path: &str, body: &B) -> Result<T, ApiError>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.send(self.with_body(Method::POST, path, body)?)
    }

    /// `PUT` with a JSON body.
    pub fn put<B, T>(&self, path: &str, body: &B) -> Result<T, ApiError>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.send(self.with_body(Method::PUT, path, body)?)
    }

    /// `DELETE`. An empty answer decodes as `null` (use `()` or `Option`).
    pub fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        self.send(self.request(Method::DELETE, path))
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.base_url))
            .header(self.header.clone(), self.token.clone())
    }

    fn with_body<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> Result<RequestBuilder, ApiError> {
        let body = serde_json::to_vec(body)
            .map_err(|error| ApiError::local(codes::API_INVALID_BODY, error))?;
        Ok(self
            .request(method, path)
            .header(CONTENT_TYPE, "application/json")
            .body(body))
    }

    fn send<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T, ApiError> {
        let response = request
            .send()
            .map_err(|error| ApiError::local(codes::API_UNREACHABLE, error))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .map_err(|error| ApiError::local(codes::API_UNREACHABLE, error))?;
        if !status.is_success() {
            return Err(match serde_json::from_slice::<ErrorShape>(&bytes) {
                Ok(shape) => ApiError {
                    status: Some(status.as_u16()),
                    code: shape.code,
                    message: shape.error,
                },
                Err(_) => ApiError {
                    status: Some(status.as_u16()),
                    code: codes::API_BAD_RESPONSE.into(),
                    message: format!(
                        "HTTP {status}: {}",
                        String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
                    ),
                },
            });
        }
        let bytes: &[u8] = if bytes.is_empty() { b"null" } else { &bytes };
        serde_json::from_slice(bytes).map_err(|error| ApiError {
            status: Some(status.as_u16()),
            code: codes::API_BAD_RESPONSE.into(),
            message: format!("the answer is not the expected JSON: {error}"),
        })
    }
}

/// `base_url` without its trailing `/`, when it is `http://` to a loopback
/// address with no credentials, query or fragment.
fn loopback_base_url(base_url: &str) -> Result<String, ApiError> {
    let refuse = |why: &str| {
        ApiError::local(
            codes::API_INVALID_CONFIG,
            format!("hello.api.base_url `{base_url}` {why}; the API is only reached at http://127.0.0.1"),
        )
    };
    let url = Url::parse(base_url).map_err(|_| refuse("is not a URL"))?;
    if url.scheme() != "http" {
        return Err(refuse("is not plain http://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refuse("carries credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(refuse("has a query or fragment"));
    }
    let loopback = match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback()),
        None => false,
    };
    if !loopback {
        return Err(refuse("is not a loopback address"));
    }
    Ok(base_url.trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use serde_json::{json, Value};

    use super::*;

    /// Answers `count` requests by path, each on its own connection; returns
    /// every request head and body it received.
    fn serve(count: usize) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            (0..count)
                .map(|_| {
                    let (stream, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let (mut head, mut length) = (String::new(), 0);
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                            length = value.trim().parse().unwrap();
                        }
                        if line == "\r\n" {
                            break;
                        }
                        head.push_str(&line);
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let path = head.split(' ').nth(1).unwrap().to_owned();
                    let (status, body_out) = match path.as_str() {
                        "/ok" => ("200 OK", r#"{"n":1}"#),
                        "/denied" => ("403 Forbidden", r#"{"error":"no","code":"PLUGIN_SCOPE_DENIED"}"#),
                        "/empty" => ("204 No Content", ""),
                        _ => ("500 Internal Server Error", "<html>"),
                    };
                    let mut stream = stream;
                    write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_out}",
                        body_out.len()
                    )
                    .unwrap();
                    head + &String::from_utf8(body).unwrap()
                })
                .collect()
        });
        (base_url, server)
    }

    #[test]
    fn sends_the_token_and_decodes_answers_and_errors() {
        let (base_url, server) = serve(4);
        let api = Api::new(&ApiInfo {
            base_url: format!("{base_url}/"),
            token_header: crate::protocol::TOKEN_HEADER.into(),
            token: "secret".into(),
        })
        .unwrap();
        let ok: Value = api.post("/ok", &json!({"a": 1})).unwrap();
        assert_eq!(ok, json!({"n": 1}));
        let denied = api.get::<Value>("/denied").unwrap_err();
        assert_eq!(
            (denied.status, denied.code.as_str(), denied.message.as_str()),
            (Some(403), "PLUGIN_SCOPE_DENIED", "no")
        );
        let () = api.delete("/empty").unwrap();
        let broken = api.put::<_, Value>("/broken", &json!(null)).unwrap_err();
        assert_eq!(broken.code, codes::API_BAD_RESPONSE);
        assert_eq!(Error::from(denied).code(), "PLUGIN_SCOPE_DENIED");
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST /ok "));
        assert!(requests[0].contains("x-cadencr-plugin-token: secret"));
        assert!(requests[0].ends_with(r#"{"a":1}"#));
    }

    #[test]
    fn reports_an_unreachable_api_and_a_bad_header() {
        let (base_url, server) = serve(0);
        server.join().unwrap();
        let info = |header: &str| ApiInfo {
            base_url: base_url.clone(),
            token_header: header.into(),
            token: "t".into(),
        };
        let unreachable = Api::new(&info("x-token")).unwrap().get::<Value>("/ok");
        assert_eq!(unreachable.unwrap_err().code, codes::API_UNREACHABLE);
        assert_eq!(
            Api::new(&info("bad header")).unwrap_err().code,
            codes::API_INVALID_CONFIG
        );
    }

    #[test]
    fn only_a_loopback_http_base_url_gets_the_token() {
        let api = |base_url: &str| {
            Api::new(&ApiInfo {
                base_url: base_url.into(),
                token_header: "x-token".into(),
                token: "t".into(),
            })
        };
        for good in [
            "http://127.0.0.1:5005",
            "http://127.0.0.1:5005/",
            "http://127.1.2.3:9",
            "http://[::1]:5005",
            "http://localhost:5005",
        ] {
            assert!(api(good).is_ok(), "{good}");
        }
        for bad in [
            "https://127.0.0.1:5005",
            "http://example.com",
            "http://10.0.0.2:5005",
            "http://user:pass@127.0.0.1:5005",
            "http://127.0.0.1:5005/?x=1",
            "http://127.0.0.1.example.com",
            "127.0.0.1:5005",
            "",
        ] {
            let error = api(bad).unwrap_err();
            assert_eq!(error.code, codes::API_INVALID_CONFIG, "{bad}");
            assert!(
                error.message.contains("127.0.0.1"),
                "{bad}: {}",
                error.message
            );
        }
    }

    #[test]
    fn ignores_the_proxy_environment() {
        // A proxy would answer every request itself; with `no_proxy` the
        // request reaches the local server directly.
        let (base_url, server) = serve(1);
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        drop(proxy);
        // No other test reads these variables (every client ignores them).
        std::env::set_var("HTTP_PROXY", &proxy_url);
        std::env::set_var("ALL_PROXY", &proxy_url);
        let api = Api::new(&ApiInfo {
            base_url,
            token_header: "x-token".into(),
            token: "t".into(),
        });
        let answer = api.and_then(|api| api.get::<Value>("/ok"));
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("ALL_PROXY");
        assert_eq!(answer.unwrap(), json!({"n": 1}));
        server.join().unwrap();
    }
}
