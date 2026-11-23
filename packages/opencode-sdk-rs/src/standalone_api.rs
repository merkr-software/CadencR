//! OpenCode 2.x HTTP API through `opencode api --standalone`.
//!
//! 2.x `opencode acp` keeps its server private (random port and password), so
//! Cadencr cannot reach it. `opencode api --standalone` starts a short-lived
//! private server on the same database instead, sends one request and prints
//! the JSON response: a session the live ACP process owns is visible to it.
//! A failed request exits 1 with the error body on stdout and `HTTP <status>`
//! on stderr.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::cli_command::capture_opencode_command;
use crate::error::{CommandStderr, SdkError};

const API_TIMEOUT: Duration = Duration::from_secs(20);

/// One `opencode api --standalone` target: the binary and the directory its
/// server resolves the project from.
#[derive(Debug, Clone)]
pub struct StandaloneApi {
    binary: PathBuf,
    cwd: Option<PathBuf>,
}

impl StandaloneApi {
    pub fn new(binary: PathBuf, cwd: Option<PathBuf>) -> Self {
        Self { binary, cwd }
    }

    /// Send one request; `Value::Null` for an empty (204) response.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, SdkError> {
        let body = body.map(Value::to_string);
        let mut args = vec!["api", "--standalone", method, path];
        if let Some(body) = body.as_deref() {
            args.extend(["--data", body]);
        }
        let run =
            capture_opencode_command(&self.binary, self.cwd.as_deref(), &args, API_TIMEOUT).await?;
        if !run.status.success() {
            return Err(match http_status(&run.stderr) {
                Some(status) => SdkError::HttpStatus {
                    status,
                    body: run.stdout.trim().to_string(),
                },
                None => SdkError::CommandFailed {
                    command: run.label,
                    status: run.status,
                    stderr: CommandStderr::new(run.stderr),
                },
            });
        }
        let stdout = run.stdout.trim();
        if stdout.is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(stdout)?)
    }

    /// `GET /api/model`: every model of the directory's providers.
    pub async fn models(&self) -> Result<Value, SdkError> {
        self.request("GET", "/api/model", None).await
    }

    /// `GET /api/model/default`.
    pub async fn default_model(&self) -> Result<Value, SdkError> {
        self.request("GET", "/api/model/default", None).await
    }

    /// The directory a session is located in.
    pub async fn session_directory(&self, session_id: &str) -> Result<String, SdkError> {
        let session = self
            .request("GET", &format!("/api/session/{session_id}"), None)
            .await?;
        session
            .pointer("/data/location/directory")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| SdkError::Protocol("session response has no location".to_string()))
    }

    /// Ids of a session's user prompts, oldest first.
    pub async fn user_message_ids(&self, session_id: &str) -> Result<Vec<String>, SdkError> {
        let mut ids = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let query = match &cursor {
                Some(cursor) => format!("type=user&cursor={cursor}"),
                None => "type=user&order=asc&limit=200".to_string(),
            };
            let page = self
                .request(
                    "GET",
                    &format!("/api/session/{session_id}/message?{query}"),
                    None,
                )
                .await?;
            let messages = page.get("data").and_then(Value::as_array);
            let Some(messages) = messages.filter(|messages| !messages.is_empty()) else {
                return Ok(ids);
            };
            ids.extend(
                messages
                    .iter()
                    .filter(|message| message.get("type").and_then(Value::as_str) == Some("user"))
                    .filter_map(|message| message.get("id").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
            );
            let next = page
                .pointer("/cursor/next")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            match next {
                None => return Ok(ids),
                Some(next) if cursor.as_ref() == Some(&next) => {
                    return Err(SdkError::Protocol(format!(
                        "session {session_id} message pages repeat cursor {next}"
                    )));
                }
                Some(next) => cursor = Some(next),
            }
        }
    }

    /// Fork `session_id` with the history before `before` (all of it when
    /// `None`); returns the new session id.
    pub async fn fork_session(
        &self,
        session_id: &str,
        before: Option<&str>,
    ) -> Result<String, SdkError> {
        let body = before.map_or_else(|| json!({}), |before| json!({ "before": before }));
        let forked = self
            .request(
                "POST",
                &format!("/api/session/{session_id}/fork"),
                Some(&body),
            )
            .await?;
        forked
            .pointer("/data/id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| SdkError::Protocol("malformed fork session response".to_string()))
    }

    /// Ask OpenCode to move a session to `directory`. It applies at once when
    /// the recorded folder is gone; otherwise it waits for the next turn.
    pub async fn move_session(&self, session_id: &str, directory: &Path) -> Result<(), SdkError> {
        let body = json!({ "directory": directory.to_string_lossy() });
        self.request(
            "POST",
            &format!("/api/session/{session_id}/move"),
            Some(&body),
        )
        .await
        .map(|_| ())
    }
}

/// The status of the `HTTP 404 Not Found` line `opencode api` prints on stderr.
fn http_status(stderr: &str) -> Option<u16> {
    stderr.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        (words.next()? == "HTTP")
            .then(|| words.next()?.parse().ok())
            .flatten()
    })
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use serde_json::json;

    use super::{http_status, StandaloneApi};
    use crate::error::SdkError;

    fn fake_cli(dir: &Path, script: &str) -> StandaloneApi {
        let binary = dir.join("opencode");
        std::fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        StandaloneApi::new(binary, None)
    }

    #[test]
    fn reads_the_status_line() {
        assert_eq!(http_status("HTTP 404 Not Found\n"), Some(404));
        assert_eq!(http_status("warning\nHTTP 500 Internal\n"), Some(500));
        assert_eq!(http_status("boom"), None);
    }

    #[tokio::test]
    async fn sends_method_path_and_body_and_parses_the_response() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake_cli(
            dir.path(),
            r#"printf '%s|' "$@" > "$(dirname "$0")/args"; echo '{"data":{"id":"ses_new"}}'"#,
        );
        let id = api.fork_session("ses_1", Some("msg_2")).await.unwrap();
        assert_eq!(id, "ses_new");
        let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
        assert_eq!(
            args,
            r#"api|--standalone|POST|/api/session/ses_1/fork|--data|{"before":"msg_2"}|"#
        );
    }

    #[tokio::test]
    async fn an_http_error_keeps_status_and_body() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake_cli(
            dir.path(),
            r#"echo '{"_tag":"SessionNotFoundError"}'; echo 'HTTP 404 Not Found' >&2; exit 1"#,
        );
        let error = api.session_directory("ses_x").await.unwrap_err();
        let SdkError::HttpStatus { status, body } = error else {
            panic!("expected an HTTP status error, got {error}");
        };
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"_tag":"SessionNotFoundError"}"#);
    }

    #[tokio::test]
    async fn an_empty_response_is_null() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake_cli(dir.path(), "exit 0");
        api.move_session("ses_1", Path::new("/repo/new"))
            .await
            .unwrap();
        assert_eq!(
            api.request("GET", "/x", Some(&json!({}))).await.unwrap(),
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn pages_user_messages_until_the_cursor_ends() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake_cli(
            dir.path(),
            r#"case "$4" in
  *cursor=c2*) echo '{"data":[{"id":"u2","type":"user"}],"cursor":{}}' ;;
  *) echo '{"data":[{"id":"u1","type":"user"},{"id":"a1","type":"assistant"}],"cursor":{"next":"c2"}}' ;;
esac"#,
        );
        let ids = api.user_message_ids("ses_1").await.unwrap();
        assert_eq!(ids, vec!["u1".to_string(), "u2".to_string()]);
    }
}
