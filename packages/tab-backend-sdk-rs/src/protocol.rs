//! Reference types of the stdio protocol, version [`PROTOCOL_VERSION`].
//!
//! One JSON object per `\n`-terminated UTF-8 line. The normative contract is
//! `docs/TAB_BACKEND_PROTOCOL.md`; these types follow it exactly. Every type
//! tolerates unknown fields on input, so a host may add optional fields within
//! a protocol version.
//!
//! A line is (de)serialized through [`HostMessage`] or [`BackendMessage`],
//! which carry the `"type"` tag; the payload structs do not.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The protocol version this crate speaks, sent in `hello` and `ready`.
pub const PROTOCOL_VERSION: u32 = 1;

/// Largest stdout line (without its `\n`) a host accepts from a backend.
/// A longer line is dropped, so its request is never answered.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// How long after writing `hello` a host waits for `ready`.
pub const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// How long after closing stdin a host waits for the backend to exit before
/// terminating its process tree.
pub const EXIT_GRACE: Duration = Duration::from_secs(2);

/// Requests a host keeps in flight to one backend at most.
pub const MAX_IN_FLIGHT: usize = 16;

/// The header a backend sends its `hello` token in ([`ApiInfo::token_header`]).
pub const TOKEN_HEADER: &str = "x-cadencr-plugin-token";

/// A line the host writes to the backend's stdin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMessage {
    /// Always the first line, exactly once.
    Hello(Hello),
    Request(Request),
}

/// A line the backend writes to its stdout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackendMessage {
    /// Always the first line, exactly once, in answer to `hello`.
    Ready(Ready),
    Response(Response),
}

/// The first host line: who the backend serves and how it reaches Cadencr.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    /// The protocol version the host speaks.
    pub protocol: u32,
    pub plugin: PluginInfo,
    /// The Cadencr project of the conversation the backend serves.
    pub project_id: i64,
    /// The conversation (Cadencr "feature") the backend serves.
    pub feature_id: i64,
    /// Absolute path of the conversation's folder (its worktree, or the
    /// project folder). Not the working directory: that is the tab folder.
    pub worktree: PathBuf,
    /// Absolute path of a writable directory of this tab (mode 0700, created
    /// by the host before the backend starts, kept across runs). It is per
    /// tab, not per conversation: the tab's backends in other conversations
    /// may use it at the same time. The only place a backend may keep state:
    /// the working directory (the tab folder) is read-only for marketplace
    /// tabs.
    pub state_dir: PathBuf,
    /// The scopes the user granted the tab, e.g. `"features:read"`.
    pub scopes: Vec<String>,
    pub api: ApiInfo,
}

/// The tab package the backend belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub version: String,
}

/// The backend's own access to the Cadencr API.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiInfo {
    /// `http://127.0.0.1:<port>`, without a trailing slash.
    pub base_url: String,
    /// The header carrying [`ApiInfo::token`] ([`TOKEN_HEADER`]).
    pub token_header: String,
    /// A grant scoped to [`Hello::scopes`] and this conversation, valid while
    /// the process runs. A secret: never log it.
    pub token: String,
}

impl fmt::Debug for ApiInfo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApiInfo")
            .field("base_url", &self.base_url)
            .field("token_header", &self.token_header)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// The backend's answer to `hello`: it is ready for requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ready {
    /// Must equal [`Hello::protocol`].
    pub protocol: u32,
    /// Free-form `name/version` of the library or program, for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk: Option<String>,
}

/// Why a backend's first stdout line is not the `ready` a host expects
/// ([`parse_ready`]).
#[derive(Debug, Clone, PartialEq)]
pub enum ReadyProblem {
    /// Not a JSON object whose `type` is `"ready"`.
    NotReady,
    /// A `ready` naming another protocol: the JSON value it gave (a number
    /// or not).
    OtherProtocol(Value),
    /// A `ready` without a `protocol`.
    NoProtocol,
}

/// The host's rule for a backend's first stdout line: a JSON object whose
/// `type` is `"ready"` and whose `protocol` is the number `expected`. Other
/// fields are ignored (a non-string `sdk` reads as none).
pub fn parse_ready(line: &[u8], expected: u32) -> Result<Ready, ReadyProblem> {
    let message: Option<Value> = serde_json::from_slice(line).ok();
    let message = message
        .as_ref()
        .filter(|message| message.get("type").and_then(Value::as_str) == Some("ready"))
        .ok_or(ReadyProblem::NotReady)?;
    match message.get("protocol") {
        Some(Value::Number(got)) if got.as_u64() == Some(u64::from(expected)) => Ok(Ready {
            protocol: expected,
            sdk: message
                .get("sdk")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        Some(got) => Err(ReadyProblem::OtherProtocol(got.clone())),
        None => Err(ReadyProblem::NoProtocol),
    }
}

/// A request id, echoed verbatim (same JSON type and value) in its response.
/// The Cadencr host sends strings; numbers are accepted for other hosts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(serde_json::Number),
}

impl fmt::Display for RequestId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(id) => formatter.write_str(id),
            Self::Number(id) => write!(formatter, "{id}"),
        }
    }
}

impl From<&str> for RequestId {
    fn from(id: &str) -> Self {
        Self::String(id.to_owned())
    }
}

/// One call of a backend method.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: RequestId,
    /// The backend's own method name (1–128 characters from the Cadencr host).
    pub method: String,
    /// Any JSON value; `null` when the caller passed none.
    #[serde(default)]
    pub params: Value,
}

/// The answer to one request: exactly one of `result` and `error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: RequestId,
    /// Any JSON value. A response without `error` and without `result` means
    /// `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    /// A successful response.
    pub fn ok(id: RequestId, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    /// A failed response.
    pub fn err(id: RequestId, error: ErrorBody) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }

    /// The outcome, as the host reads it: `error` wins, a missing `result`
    /// is `null`.
    pub fn outcome(&self) -> Result<&Value, &ErrorBody> {
        const NULL: &Value = &Value::Null;
        match (&self.error, &self.result) {
            (Some(error), _) => Err(error),
            (None, result) => Ok(result.as_ref().unwrap_or(NULL)),
        }
    }
}

/// A backend's error: a stable machine-readable code and a human message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    /// Stable `SCREAMING_SNAKE_CASE` code, e.g. `"UNKNOWN_METHOD"`.
    pub code: String,
    /// One sentence for a person.
    pub message: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn host_lines_round_trip_and_tolerate_unknown_fields() {
        let line = json!({
            "type": "hello", "protocol": 1, "future": true,
            "plugin": {"id": "p", "version": "1.0.0", "extra": 1},
            "project_id": 1, "feature_id": 2, "worktree": "/w", "state_dir": "/s",
            "scopes": ["features:read"],
            "api": {"base_url": "http://127.0.0.1:1", "token_header": "x", "token": "secret"},
        });
        let HostMessage::Hello(hello) = serde_json::from_value(line).unwrap() else {
            panic!("not a hello");
        };
        assert_eq!(hello.plugin.id, "p");
        assert_eq!(hello.state_dir, PathBuf::from("/s"));
        assert!(!format!("{hello:?}").contains("secret"));
        let request: HostMessage =
            serde_json::from_value(json!({"type": "request", "id": 7, "method": "m"})).unwrap();
        assert_eq!(
            request,
            HostMessage::Request(Request {
                id: RequestId::Number(7.into()),
                method: "m".into(),
                params: Value::Null,
            })
        );
    }

    #[test]
    fn ready_follows_the_host_rule() {
        assert_eq!(
            parse_ready(br#"{"type":"ready","protocol":1}"#, 1),
            Ok(Ready {
                protocol: 1,
                sdk: None
            })
        );
        assert_eq!(
            parse_ready(br#"{"protocol":2,"type":"ready","sdk":"x"}"#, 2),
            Ok(Ready {
                protocol: 2,
                sdk: Some("x".into())
            })
        );
        for (line, expected, problem) in [
            (
                &br#"{"type":"ready","protocol":1}"#[..],
                2,
                ReadyProblem::OtherProtocol(json!(1)),
            ),
            (
                br#"{"type":"ready","protocol":"1"}"#,
                1,
                ReadyProblem::OtherProtocol(json!("1")),
            ),
            (br#"{"type":"ready"}"#, 1, ReadyProblem::NoProtocol),
            (
                br#"{"type":"response","id":"1","result":null}"#,
                1,
                ReadyProblem::NotReady,
            ),
            (b"starting up...", 1, ReadyProblem::NotReady),
            (b"", 1, ReadyProblem::NotReady),
        ] {
            assert_eq!(
                parse_ready(line, expected),
                Err(problem),
                "{}",
                String::from_utf8_lossy(line)
            );
        }
    }

    #[test]
    fn backend_lines_serialize_exactly() {
        let ready = BackendMessage::Ready(Ready {
            protocol: 1,
            sdk: None,
        });
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            json!({"type": "ready", "protocol": 1})
        );
        let ok = BackendMessage::Response(Response::ok("a".into(), Value::Null));
        assert_eq!(
            serde_json::to_value(ok).unwrap(),
            json!({"type": "response", "id": "a", "result": null})
        );
        let error = ErrorBody {
            code: "NOPE".into(),
            message: "m".into(),
        };
        let failed = Response::err(RequestId::Number(3.into()), error.clone());
        assert_eq!(failed.outcome(), Err(&error));
        assert_eq!(
            serde_json::to_value(BackendMessage::Response(failed)).unwrap(),
            json!({"type": "response", "id": 3, "error": {"code": "NOPE", "message": "m"}})
        );
        let empty: Response = serde_json::from_value(json!({"id": "x"})).unwrap();
        assert_eq!(empty.outcome(), Ok(&Value::Null));
    }
}
