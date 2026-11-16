//! Header hygiene and `{{secret:<key>}}` substitution for the egress relay.

use std::collections::{BTreeMap, BTreeSet};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION};

use crate::error::AppError;

/// Never relayed in either direction: connection-scoped (RFC 9110 §7.6.1),
/// set by the relay itself, or cookies (a plugin has no cookie jar).
const STRIPPED: [&str; 14] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "cookie",
    "set-cookie",
    "cookie2",
];

const SECRET_OPEN: &str = "{{secret:";
const SECRET_CLOSE: &str = "}}";

fn is_stripped(name: &str, listed_in_connection: &BTreeSet<String>) -> bool {
    STRIPPED.contains(&name) || name == "set-cookie2" || listed_in_connection.contains(name)
}

/// Header names a `Connection` header nominates as hop-by-hop.
fn connection_tokens<'a>(values: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    values
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

/// The `{{secret:<key>}}` keys referenced by `value`, in order.
pub fn secret_keys(value: &str) -> Vec<&str> {
    let mut keys = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find(SECRET_OPEN) {
        let after = &rest[start + SECRET_OPEN.len()..];
        let Some(end) = after.find(SECRET_CLOSE) else {
            break;
        };
        keys.push(&after[..end]);
        rest = &after[end + SECRET_CLOSE.len()..];
    }
    keys
}

/// Replace every placeholder in `value` with its secret.
pub fn substitute(value: &str, secrets: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(SECRET_OPEN) {
        let after = &rest[start + SECRET_OPEN.len()..];
        let Some(end) = after.find(SECRET_CLOSE) else {
            break;
        };
        out.push_str(&rest[..start]);
        match secrets.get(&after[..end]) {
            Some(secret) => out.push_str(secret),
            None => {
                out.push_str(&rest[start..start + SECRET_OPEN.len() + end + SECRET_CLOSE.len()])
            }
        }
        rest = &after[end + SECRET_CLOSE.len()..];
    }
    out.push_str(rest);
    out
}

/// The outbound header map: names validated, hop-by-hop and cookie headers
/// dropped, placeholders already substituted by the caller. Returns the map
/// and the names whose value carried a secret (dropped on a cross-origin
/// redirect).
pub fn outbound(
    headers: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
) -> Result<(HeaderMap, Vec<HeaderName>), AppError> {
    let listed = connection_tokens(
        headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(CONNECTION.as_str()))
            .map(|(_, value)| value.as_str()),
    );
    let mut map = HeaderMap::new();
    let mut secret_bearing = Vec::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::BadRequest(format!("`{name}` is not a valid header name")))?;
        if is_stripped(name.as_str(), &listed) {
            continue;
        }
        let carries_secret = !secret_keys(value).is_empty();
        // Bytes, not `from_str`: a non-ASCII value (sent `\uXXXX`-escaped in the
        // JSON) goes upstream as UTF-8 rather than being refused.
        let value =
            HeaderValue::from_bytes(substitute(value, secrets).as_bytes()).map_err(|_| {
                AppError::BadRequest(format!("the value of `{name}` is not a valid header value"))
            })?;
        if carries_secret {
            secret_bearing.push(name.clone());
        }
        map.append(name, value);
    }
    Ok((map, secret_bearing))
}

/// The response headers a plugin sees: lowercase names, repeated values joined
/// with `, `, hop-by-hop and cookie headers removed, non-UTF-8 values dropped.
pub fn inbound(headers: &HeaderMap) -> BTreeMap<String, String> {
    let listed = connection_tokens(
        headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok()),
    );
    let mut out = BTreeMap::<String, String>::new();
    for (name, value) in headers {
        let name = name.as_str();
        let Ok(value) = value.to_str() else {
            continue;
        };
        if is_stripped(name, &listed) {
            continue;
        }
        out.entry(name.to_string())
            .and_modify(|joined| {
                joined.push_str(", ");
                joined.push_str(value);
            })
            .or_insert_with(|| value.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn finds_and_substitutes_secret_placeholders() {
        assert_eq!(secret_keys("Bearer {{secret:token}}"), ["token"]);
        assert_eq!(secret_keys("{{secret:a}}-{{secret:b}}"), ["a", "b"]);
        assert!(secret_keys("{{secret:open").is_empty());
        let secrets = map(&[("token", "s3cret")]);
        assert_eq!(
            substitute("Bearer {{secret:token}}!", &secrets),
            "Bearer s3cret!"
        );
        assert_eq!(
            substitute("{{secret:missing}}", &secrets),
            "{{secret:missing}}"
        );
        assert_eq!(substitute("plain", &secrets), "plain");
    }

    #[test]
    fn outbound_strips_hop_by_hop_and_cookies_and_tracks_secret_headers() {
        let (headers, secret) = outbound(
            &map(&[
                ("Authorization", "Bearer {{secret:token}}"),
                ("Accept", "application/json"),
                ("Cookie", "a=1"),
                ("Connection", "x-private"),
                ("X-Private", "1"),
                ("Host", "evil.example"),
                ("Transfer-Encoding", "chunked"),
            ]),
            &map(&[("token", "s3cret")]),
        )
        .unwrap();
        let names: Vec<&str> = headers.keys().map(HeaderName::as_str).collect();
        assert_eq!(names, ["accept", "authorization"]);
        assert_eq!(headers["authorization"], "Bearer s3cret");
        assert_eq!(secret, [HeaderName::from_static("authorization")]);
        assert!(outbound(&map(&[("bad name", "x")]), &BTreeMap::new()).is_err());
        assert!(outbound(&map(&[("x", "a\nb")]), &BTreeMap::new()).is_err());
        let (headers, _) = outbound(&map(&[("X-Name", "日本語")]), &BTreeMap::new()).unwrap();
        assert_eq!(headers["x-name"].as_bytes(), "日本語".as_bytes());
    }

    #[test]
    fn inbound_joins_repeats_and_drops_cookies() {
        let mut headers = HeaderMap::new();
        headers.append("set-cookie", HeaderValue::from_static("a=1"));
        headers.append("vary", HeaderValue::from_static("accept"));
        headers.append("vary", HeaderValue::from_static("origin"));
        headers.append("connection", HeaderValue::from_static("close, x-hop"));
        headers.append("x-hop", HeaderValue::from_static("1"));
        headers.append("content-type", HeaderValue::from_static("text/plain"));
        assert_eq!(
            inbound(&headers),
            map(&[("content-type", "text/plain"), ("vary", "accept, origin")])
        );
    }
}
