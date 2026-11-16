//! What one host line after `hello` is, and the `hello` itself.

use serde_json::{Map, Value};

use crate::error::{codes, Error};
use crate::protocol::{Hello, Request, RequestId, PROTOCOL_VERSION};
use crate::server::ServeError;

pub(crate) enum Incoming {
    Request(Request),
    /// A request-shaped line with a usable id but no usable method: it is
    /// answered with [`codes::INVALID_REQUEST`].
    Invalid(RequestId, Error),
    /// Not for us (not JSON, no id, an unknown `type`, …): logged and skipped.
    Ignored(String),
}

pub(crate) fn classify(line: &[u8]) -> Incoming {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return Incoming::Ignored("ignored a line that is not JSON".into());
    };
    let Value::Object(object) = value else {
        return Incoming::Ignored("ignored a line that is not a JSON object".into());
    };
    match object.get("type").and_then(Value::as_str) {
        Some("request") | None => request(object),
        Some("hello") => Incoming::Ignored("ignored a second `hello`".into()),
        // A later minor addition of the host, or noise: never fatal.
        Some(other) => Incoming::Ignored(format!("ignored a `{other}` line")),
    }
}

fn request(mut object: Map<String, Value>) -> Incoming {
    let id = match object.remove("id").map(serde_json::from_value::<RequestId>) {
        Some(Ok(id)) => id,
        _ => return Incoming::Ignored("ignored a request without a string or number id".into()),
    };
    let invalid =
        |message: &str| Incoming::Invalid(id.clone(), Error::new(codes::INVALID_REQUEST, message));
    if object.get("type").is_none() {
        return invalid("the line has no `type`");
    }
    let method = match object.remove("method") {
        Some(Value::String(method)) if !method.is_empty() => method,
        _ => return invalid("`method` must be a non-empty string"),
    };
    let params = object.remove("params").unwrap_or(Value::Null);
    Incoming::Request(Request { id, method, params })
}

/// The `hello` on the first line, checked.
pub(crate) fn hello(line: &[u8]) -> Result<Hello, ServeError> {
    let value: Value = serde_json::from_slice(line).map_err(|error| {
        ServeError::InvalidHello(format!("the first line is not JSON: {error}"))
    })?;
    let kind = value.get("type").and_then(Value::as_str);
    if kind != Some("hello") {
        return Err(ServeError::NotHello(kind.map_or_else(
            || "a line without a type".into(),
            |kind| format!("`{kind}`"),
        )));
    }
    let protocol = value.get("protocol").cloned().unwrap_or(Value::Null);
    if protocol != PROTOCOL_VERSION {
        return Err(ServeError::ProtocolMismatch { host: protocol });
    }
    serde_json::from_value(value).map_err(|error| ServeError::InvalidHello(error.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn line(value: Value) -> Vec<u8> {
        value.to_string().into_bytes()
    }

    #[test]
    fn classifies_requests_invalid_and_ignored_lines() {
        let ok = classify(&line(json!({"type": "request", "id": "1", "method": "m"})));
        assert!(matches!(ok, Incoming::Request(r) if r.params.is_null() && r.method == "m"));
        let no_method = classify(&line(json!({"type": "request", "id": 2})));
        assert!(
            matches!(no_method, Incoming::Invalid(RequestId::Number(_), e)
            if e.code() == codes::INVALID_REQUEST)
        );
        let untyped = classify(&line(json!({"id": "3", "method": "m"})));
        assert!(matches!(untyped, Incoming::Invalid(..)));
        for ignored in [
            b"nope".to_vec(),
            line(json!([1])),
            line(json!({"type": "request", "method": "m"})),
            line(json!({"type": "request", "id": true, "method": "m"})),
            line(json!({"type": "notice", "id": "4"})),
            line(json!({"type": "hello", "protocol": 1})),
        ] {
            assert!(matches!(classify(&ignored), Incoming::Ignored(_)));
        }
    }

    #[test]
    fn checks_the_hello() {
        let mut valid = serde_json::to_value(crate::protocol::HostMessage::Hello(
            crate::testing::sample_hello(),
        ))
        .unwrap();
        assert!(hello(&line(valid.clone())).is_ok());
        assert!(matches!(
            hello(&line(json!({"type": "request"}))),
            Err(ServeError::NotHello(_))
        ));
        valid["protocol"] = json!(2);
        assert!(matches!(
            hello(&line(valid.clone())),
            Err(ServeError::ProtocolMismatch { host }) if host == json!(2)
        ));
        valid["protocol"] = json!(1);
        valid["api"] = json!(null);
        assert!(matches!(
            hello(&line(valid)),
            Err(ServeError::InvalidHello(_))
        ));
    }
}
