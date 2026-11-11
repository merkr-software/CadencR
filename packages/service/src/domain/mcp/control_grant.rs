//! Control grants: what one Cadencr MCP subprocess may do on `/internal/mcp/*`.
//!
//! Each project or workspace MCP subprocess gets its own token, minted when the
//! agent runtime is configured and bound to the conversation (feature), the
//! source session and the one server it serves. The process-wide secret that
//! signs them never leaves the service. The control middleware derives the
//! caller's identity from the token: a request may only speak as that source
//! (`source_session_id` / `source_feature_id` in its JSON body, or in the query
//! of a bodiless request) and only on its server's routes, so a workspace route
//! is refused unless the workspace server was attached. Grants are stateless (HMAC-SHA256), so there is nothing
//! to revoke: a deleted session simply no longer resolves in the handlers.
//!
//! Format: `mc1.<p|w>.<feature_id>.<session_id>.<base64url(HMAC)>`.

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode, Uri};
use serde::Deserialize;

use crate::api::middleware::MCP_CONTROL_HEADER;
use crate::error::AppError;
use crate::shared::security::{constant_time_str_eq, hmac_sha256_base64url};

const PREFIX: &str = "mc1";

/// The control secret of `AppState::with_pool`, for tests that mint grants
/// against it.
pub const TEST_MCP_CONTROL_SECRET: &str = "test-mcp-secret";

/// The Cadencr MCP server a control grant was minted for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpControlServer {
    Project,
    Workspace,
}

impl McpControlServer {
    fn code(self) -> &'static str {
        match self {
            Self::Project => "p",
            Self::Workspace => "w",
        }
    }

    fn from_code(code: &str) -> Option<Self> {
        match code {
            "p" => Some(Self::Project),
            "w" => Some(Self::Workspace),
            _ => None,
        }
    }

    /// The MCP server name agents see (`cadencr-<short name>`).
    pub(crate) fn server_name(self) -> &'static str {
        match self {
            Self::Project => "cadencr-project",
            Self::Workspace => "cadencr-workspace",
        }
    }

    /// The server whose routes `path` belongs to.
    fn for_path(path: &str) -> Option<Self> {
        if path.starts_with("/internal/mcp/project/") {
            Some(Self::Project)
        } else if path.starts_with("/internal/mcp/workspace/") {
            Some(Self::Workspace)
        } else {
            None
        }
    }
}

/// Who a control token speaks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpControlGrant {
    pub server: McpControlServer,
    pub feature_id: i64,
    pub session_id: i64,
}

impl McpControlGrant {
    /// The token handed to the MCP subprocess this grant describes.
    pub fn mint(&self, secret: &str) -> String {
        let claims = format!(
            "{PREFIX}.{}.{}.{}",
            self.server.code(),
            self.feature_id,
            self.session_id
        );
        format!("{claims}.{}", hmac_sha256_base64url(secret, &claims))
    }

    /// The grant a request's `x-cadencr-mcp-token` header carries, if any.
    pub fn from_headers(headers: &HeaderMap, secret: &str) -> Option<Self> {
        let token = headers.get(MCP_CONTROL_HEADER)?.to_str().ok()?;
        Self::verify(secret, token)
    }

    /// The grant `token` carries, when `secret` signed it.
    pub fn verify(secret: &str, token: &str) -> Option<Self> {
        let (claims, _) = token.rsplit_once('.')?;
        let mut parts = claims.split('.');
        let (Some(PREFIX), Some(server), Some(feature), Some(session), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return None;
        };
        let grant = Self {
            server: McpControlServer::from_code(server)?,
            feature_id: feature.parse().ok()?,
            session_id: session.parse().ok()?,
        };
        // Re-mint from the parsed values: a non-canonical number ("007") fails.
        constant_time_str_eq(&grant.mint(secret), token).then_some(grant)
    }

    /// Refuse a request outside this grant: another server's route, or a
    /// source identity that is not the grant's. The source is read wherever a
    /// handler may read it — the query (`source_session_id`, `feature_id`) and
    /// the JSON object body — with the same serde rules as the handlers
    /// (unknown fields skipped, a repeated field refused), and any source
    /// either names must be the grant's. A body that is not a JSON object is
    /// refused outright, so no handler can parse an identity this check did
    /// not see. Every control request names its source session: in its body
    /// when it has one, else in its query.
    pub fn check_request(&self, uri: &Uri, body: &[u8]) -> Result<(), AppError> {
        if McpControlServer::for_path(uri.path()) != Some(self.server) {
            return Err(out_of_scope("this MCP server may not call this route"));
        }
        let Query(query) =
            Query::<QuerySource>::try_from_uri(uri).map_err(|_| unreadable("query"))?;
        let query = NamedSource {
            source_session_id: query.source_session_id,
            source_feature_id: query.feature_id.or(query.source_feature_id),
        };
        self.require_own(&query)?;
        let named = if body.is_empty() {
            query
        } else if body.trim_ascii_start().starts_with(b"{") {
            let body =
                serde_json::from_slice::<NamedSource>(body).map_err(|_| unreadable("body"))?;
            self.require_own(&body)?;
            body
        } else {
            return Err(unreadable("body"));
        };
        self.require(named.source_session_id.is_some())
    }

    /// Whatever `source` names is the grant's own source.
    fn require_own(&self, source: &NamedSource) -> Result<(), AppError> {
        self.require(
            source
                .source_session_id
                .is_none_or(|session_id| session_id == self.session_id),
        )?;
        self.require(
            source
                .source_feature_id
                .is_none_or(|feature_id| feature_id == self.feature_id),
        )
    }

    fn require(&self, matches: bool) -> Result<(), AppError> {
        if matches {
            Ok(())
        } else {
            Err(out_of_scope(
                "a control request may only speak for the session its MCP server was started for",
            ))
        }
    }
}

/// The source identity of a request body.
#[derive(Deserialize)]
struct NamedSource {
    source_session_id: Option<i64>,
    source_feature_id: Option<i64>,
}

/// The source identity of a request's query.
#[derive(Deserialize)]
struct QuerySource {
    source_session_id: Option<i64>,
    feature_id: Option<i64>,
    source_feature_id: Option<i64>,
}

fn unreadable(part: &str) -> AppError {
    AppError::coded(
        StatusCode::BAD_REQUEST,
        "MCP_CONTROL_REQUEST_INVALID",
        format!("the control request {part} is not a readable JSON object or query"),
    )
}

fn out_of_scope(message: &str) -> AppError {
    AppError::coded(StatusCode::FORBIDDEN, "MCP_CONTROL_OUT_OF_SCOPE", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const SECRET: &str = "process-secret";

    fn project() -> McpControlGrant {
        McpControlGrant {
            server: McpControlServer::Project,
            feature_id: 42,
            session_id: 777,
        }
    }

    fn check(grant: McpControlGrant, uri: &str, body: &[u8]) -> Result<(), &'static str> {
        grant
            .check_request(&uri.parse().unwrap(), body)
            .map_err(|error| match error {
                AppError::Coded { code, .. } => code,
                other => panic!("expected a coded error, got {other:?}"),
            })
    }

    fn body(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).unwrap()
    }

    #[test]
    fn a_minted_token_verifies_only_with_its_secret_and_unaltered() {
        let token = project().mint(SECRET);
        assert!(!token.contains(SECRET));
        assert_eq!(McpControlGrant::verify(SECRET, &token), Some(project()));
        assert_eq!(McpControlGrant::verify("other", &token), None);
        for forged in [
            token.replace("mc1.p.42.", "mc1.p.43."),
            token.replace("mc1.p.", "mc1.w."),
            token.replace("mc1.p.42.", "mc1.p.042."),
            format!("{token}x"),
            SECRET.to_string(),
            String::new(),
        ] {
            assert_eq!(McpControlGrant::verify(SECRET, &forged), None, "{forged}");
        }
        let mut headers = HeaderMap::new();
        headers.insert(MCP_CONTROL_HEADER, token.parse().unwrap());
        assert_eq!(
            McpControlGrant::from_headers(&headers, SECRET),
            Some(project())
        );
        assert_eq!(
            McpControlGrant::from_headers(&HeaderMap::new(), SECRET),
            None
        );
    }

    #[test]
    fn a_grant_speaks_only_for_its_own_source() {
        let send = "/internal/mcp/project/send-message";
        let own = body(json!({"source_feature_id": 42, "source_session_id": 777, "x": 1}));
        assert_eq!(check(project(), send, &own), Ok(()));
        let gates = body(json!({"source_session_id": 777, "session_id": 5}));
        assert_eq!(
            check(project(), "/internal/mcp/project/pending-gates", &gates),
            Ok(())
        );
        for other in [
            json!({"source_feature_id": 42, "source_session_id": 778}),
            json!({"source_feature_id": 41, "source_session_id": 777}),
            json!({"source_feature_id": 42}),
            json!({}),
        ] {
            assert_eq!(
                check(project(), send, &body(other)),
                Err("MCP_CONTROL_OUT_OF_SCOPE")
            );
        }
        assert_eq!(check(project(), send, b""), Err("MCP_CONTROL_OUT_OF_SCOPE"));
    }

    /// The query of a request with a body is not where its handler reads the
    /// source: a body naming another session is refused however it is shaped.
    #[test]
    fn a_body_the_check_cannot_read_never_reaches_a_handler() {
        let send = "/internal/mcp/project/send-message?source_session_id=777&feature_id=42";
        let mut invalid_utf8 = br#"{"source_feature_id":99,"source_session_id":555,"x":""#.to_vec();
        invalid_utf8.extend_from_slice(&[0xFF, b'"', b'}']);
        let deep = format!(
            r#"{{"source_session_id":555,"x":{}{}}}"#,
            "[".repeat(200),
            "]".repeat(200)
        );
        for foreign in [invalid_utf8, deep.into_bytes()] {
            assert!(check(project(), send, &foreign).is_err());
        }
        for unreadable in [
            // Positional: a struct would read it in its own field order.
            b"[777, 42]".to_vec(),
            br#"{"source_session_id":777,"source_session_id":555}"#.to_vec(),
            br#"{"source_session_id":"777"}"#.to_vec(),
            b"not json".to_vec(),
        ] {
            assert_eq!(
                check(project(), send, &unreadable),
                Err("MCP_CONTROL_REQUEST_INVALID"),
                "{}",
                String::from_utf8_lossy(&unreadable)
            );
        }
    }

    #[test]
    fn a_bodiless_request_names_its_source_in_the_query() {
        let context = "/internal/mcp/project/context";
        let at = |query: &str| check(project(), &format!("{context}?{query}"), b"");
        assert_eq!(at("feature_id=42&source_session_id=777"), Ok(()));
        assert_eq!(
            at("feature_id=41&source_session_id=777"),
            Err("MCP_CONTROL_OUT_OF_SCOPE")
        );
        assert_eq!(
            at("feature_id=42&source_session_id=1"),
            Err("MCP_CONTROL_OUT_OF_SCOPE")
        );
        assert_eq!(
            at("source_session_id=1&source_session_id=777"),
            Err("MCP_CONTROL_REQUEST_INVALID")
        );
        // A body does not stand in for the query a GET handler reads.
        let own = body(json!({"source_session_id": 777}));
        assert_eq!(
            check(
                project(),
                &format!("{context}?feature_id=999&source_session_id=1"),
                &own
            ),
            Err("MCP_CONTROL_OUT_OF_SCOPE")
        );
        assert_eq!(
            check(
                project(),
                &format!("{context}?feature_id=42&source_session_id=777"),
                &own
            ),
            Ok(())
        );
    }

    #[test]
    fn a_grant_reaches_only_its_server_routes() {
        let own = body(json!({"source_feature_id": 42, "source_session_id": 777}));
        let workspace = McpControlGrant {
            server: McpControlServer::Workspace,
            ..project()
        };
        for path in [
            "/internal/mcp/workspace/send-message",
            "/internal/mcp/workspace/update-settings",
        ] {
            assert_eq!(
                check(project(), path, &own),
                Err("MCP_CONTROL_OUT_OF_SCOPE")
            );
            assert_eq!(check(workspace, path, &own), Ok(()));
        }
        assert!(check(workspace, "/internal/mcp/project/spawn-session", &own).is_err());
        assert!(check(project(), "/internal/mcp/elsewhere", &own).is_err());
    }
}
