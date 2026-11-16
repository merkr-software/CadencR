//! Building blocks for fetching a URL on someone else's behalf (the forge
//! image proxy, the custom-tab egress relay): redirects followed by hand so
//! every hop is re-checked, DNS answers validated and pinned so a second
//! lookup cannot rebind the host, and bodies read under a hard cap.
//!
//! Each caller keeps its own error wording; these return plain reasons.

mod public_ip;

use std::net::IpAddr;

use futures::StreamExt;
use reqwest::header::LOCATION;
use reqwest::{Client, ClientBuilder, Response, Url};

pub use public_ip::is_public_ip;

/// Why a hop could not be pinned.
#[derive(Debug)]
pub enum PinError {
    MissingHost,
    Resolve(String),
    NoAddress,
    /// The host is, or resolves to, a non-public address.
    Private(IpAddr),
    Build(reqwest::Error),
}

/// Why a capped body could not be read.
#[derive(Debug)]
pub enum ReadError {
    TooLarge,
    Body(reqwest::Error),
}

/// The next hop when `response` is a redirect (301/302/303/307/308), resolved
/// against `current`. A redirect with no usable `Location` is an error rather
/// than a final answer, so it cannot be mistaken for content.
pub fn redirect_target(response: &Response, current: &Url) -> Result<Option<Url>, String> {
    if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
        return Ok(None);
    }
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "redirected without a Location".to_string())?;
    current
        .join(location)
        .map(Some)
        .map_err(|error| format!("unreadable redirect location: {error}"))
}

/// Read the body, refusing it past `max_bytes` — up front from
/// `Content-Length`, then while streaming (a chunked body announces nothing).
pub async fn read_capped(response: Response, max_bytes: usize) -> Result<Vec<u8>, ReadError> {
    let announced = response.content_length();
    if announced.is_some_and(|length| length > max_bytes as u64) {
        return Err(ReadError::TooLarge);
    }
    let mut body = Vec::with_capacity(announced.map_or(0, |length| length as usize));
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(ReadError::Body)?;
        if body.len() + chunk.len() > max_bytes {
            return Err(ReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Resolve `url`'s host once, refuse non-public answers unless
/// `allow_private`, and pin the accepted addresses into `builder`, so reqwest
/// cannot make a second, unchecked lookup (the DNS-rebinding TOCTOU). An IP
/// literal is checked as is. Proxies are disabled: a proxy would resolve the
/// host itself.
pub async fn pinned_client(
    builder: ClientBuilder,
    url: &Url,
    allow_private: bool,
) -> Result<Client, PinError> {
    let host = url.host_str().ok_or(PinError::MissingHost)?;
    let mut builder = builder
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(address) = bare.parse::<IpAddr>() {
        check(address, allow_private)?;
    } else {
        let port = url.port_or_known_default().unwrap_or(443);
        let addresses = tokio::net::lookup_host((host, port))
            .await
            .map_err(|error| PinError::Resolve(error.to_string()))?
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(PinError::NoAddress);
        }
        for address in &addresses {
            check(address.ip(), allow_private)?;
        }
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    builder.build().map_err(PinError::Build)
}

fn check(address: IpAddr, allow_private: bool) -> Result<(), PinError> {
    if allow_private || is_public_ip(address) {
        Ok(())
    } else {
        Err(PinError::Private(address))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, headers: &[(&str, &str)], body: &str) -> Response {
        let mut builder = axum::http::Response::builder().status(status);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        Response::from(builder.body(body.to_string()).expect("build test response"))
    }

    #[test]
    fn a_relative_redirect_is_resolved_against_the_hop_it_came_from() {
        let current = Url::parse("https://github.com/acme/repo/blob/main/a.png").unwrap();
        let next = redirect_target(
            &response(302, &[("location", "/user-attachments/assets/1")], ""),
            &current,
        )
        .expect("redirect resolves")
        .expect("redirect present");
        assert_eq!(
            next.as_str(),
            "https://github.com/user-attachments/assets/1"
        );
        for terminal in [200, 304, 300] {
            assert!(redirect_target(&response(terminal, &[], ""), &current)
                .expect("terminal response")
                .is_none());
        }
    }

    #[test]
    fn a_redirect_without_a_location_is_refused_rather_than_looped() {
        let current = Url::parse("https://github.com/a.png").unwrap();
        assert!(redirect_target(&response(302, &[], ""), &current).is_err());
    }

    #[tokio::test]
    async fn bodies_are_capped() {
        let body = read_capped(response(200, &[], "abcd"), 4).await.unwrap();
        assert_eq!(body, b"abcd");
        assert!(matches!(
            read_capped(response(200, &[], "abcde"), 4).await,
            Err(ReadError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn private_targets_are_refused_unless_allowed() {
        let pin = |url: &str, allow_private: bool| {
            let url = Url::parse(url).unwrap();
            async move { pinned_client(Client::builder(), &url, allow_private).await }
        };
        assert!(matches!(
            pin("http://127.0.0.1:9/", false).await,
            Err(PinError::Private(_))
        ));
        assert!(matches!(
            pin("https://[::1]/", false).await,
            Err(PinError::Private(_))
        ));
        assert!(matches!(
            pin("https://10.1.2.3/", false).await,
            Err(PinError::Private(_))
        ));
        // `localhost` resolves to loopback: refused unless explicitly allowed.
        assert!(matches!(
            pin("http://localhost:9/", false).await,
            Err(PinError::Private(_))
        ));
        assert!(pin("http://localhost:9/", true).await.is_ok());
        assert!(pin("http://127.0.0.1:9/", true).await.is_ok());
        assert!(pin("https://1.1.1.1/", false).await.is_ok());
    }
}
