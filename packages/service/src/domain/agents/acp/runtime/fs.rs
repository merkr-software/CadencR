//! Server-side handlers for ACP `fs/read_text_file` and `fs/write_text_file`.
//!
//! ACP agents call these on the client (us). We sandbox to the session's cwd
//! to avoid the agent reading or writing outside the working directory.
//! Errors are returned as JSON-RPC error objects via `reject_server_request`
//! in the caller; this module only computes outcomes.

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{AgentRequest, ReadTextFileRequest, WriteTextFileRequest};
use serde_json::{json, Value};

use crate::domain::agents::acp::incoming::AcpServerRequest;

mod line_window;

pub(super) use line_window::apply_line_window;

/// Outcome of an `fs/*` handler. Either a successful result `Value` to send
/// back or a `(code, message)` pair to reject with.
pub enum FsOutcome {
    Ok(Value),
    Error { code: i64, message: String },
}

/// Typed variant of [`handle_read_text_file`] used when the inbound request
/// deserializes cleanly into the official ACP schema. Shares scaffolding
/// with the raw handler via [`read_text_file_at_path`].
async fn handle_read_text_file_typed(cwd: &Path, request: &ReadTextFileRequest) -> FsOutcome {
    read_text_file_at_path(
        cwd,
        &request.path.to_string_lossy(),
        request.line.map(u64::from),
        request.limit.map(u64::from),
    )
    .await
}

/// Typed variant of [`handle_write_text_file`] used when the inbound request
/// deserializes cleanly into the official ACP schema. Shares scaffolding
/// with the raw handler via [`write_text_file_at_path`].
async fn handle_write_text_file_typed(cwd: &Path, request: &WriteTextFileRequest) -> FsOutcome {
    write_text_file_at_path(cwd, &request.path.to_string_lossy(), &request.content).await
}

async fn read_text_file_at_path(
    cwd: &Path,
    requested: &str,
    line: Option<u64>,
    limit: Option<u64>,
) -> FsOutcome {
    let path = match sandboxed_path(cwd, requested).await {
        Ok(p) => p,
        Err(message) => {
            return FsOutcome::Error {
                code: -32602,
                message,
            }
        }
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => {
            FsOutcome::Ok(json!({ "content": apply_line_window(&content, line, limit) }))
        }
        Err(error) => FsOutcome::Error {
            code: -32000,
            message: format!("fs/read_text_file: {error}"),
        },
    }
}

async fn write_text_file_at_path(cwd: &Path, requested: &str, content: &str) -> FsOutcome {
    let path = match sandboxed_path(cwd, requested).await {
        Ok(p) => p,
        Err(message) => {
            return FsOutcome::Error {
                code: -32602,
                message,
            }
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return FsOutcome::Error {
                code: -32000,
                message: format!("fs/write_text_file: failed to create parent: {error}"),
            };
        }
    }
    match tokio::fs::write(path, content).await {
        Ok(()) => FsOutcome::Ok(Value::Null),
        Err(error) => FsOutcome::Error {
            code: -32000,
            message: format!("fs/write_text_file: {error}"),
        },
    }
}

/// Handle an `fs/read_text_file` request. Reads the file at the requested
/// path and returns `{ content }`. Honors `line` (1-based) and `limit`.
pub async fn handle_read_text_file(request: &AcpServerRequest, cwd: &Path) -> FsOutcome {
    if let Some(typed) = request.typed_as(read_text_file_request) {
        return handle_read_text_file_typed(cwd, typed).await;
    }
    handle_read_text_file_raw(cwd, request.params()).await
}

async fn handle_read_text_file_raw(cwd: &Path, params: &Value) -> FsOutcome {
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return FsOutcome::Error {
            code: -32602,
            message: "fs/read_text_file: missing 'path'".to_string(),
        };
    };
    let line = params.get("line").and_then(Value::as_u64);
    let limit = params.get("limit").and_then(Value::as_u64);
    read_text_file_at_path(cwd, path, line, limit).await
}

/// Handle an `fs/write_text_file` request. Writes `content` to `path`,
/// creating parent directories as needed. Returns `null` on success.
pub async fn handle_write_text_file(request: &AcpServerRequest, cwd: &Path) -> FsOutcome {
    if let Some(typed) = request.typed_as(write_text_file_request) {
        return handle_write_text_file_typed(cwd, typed).await;
    }
    handle_write_text_file_raw(cwd, request.params()).await
}

async fn handle_write_text_file_raw(cwd: &Path, params: &Value) -> FsOutcome {
    let (Some(path), Some(content)) = (
        params.get("path").and_then(Value::as_str),
        params.get("content").and_then(Value::as_str),
    ) else {
        return FsOutcome::Error {
            code: -32602,
            message: "fs/write_text_file: missing 'path' or 'content'".to_string(),
        };
    };
    write_text_file_at_path(cwd, path, content).await
}

fn read_text_file_request(request: &AgentRequest) -> Option<&ReadTextFileRequest> {
    match request {
        AgentRequest::ReadTextFileRequest(request) => Some(request),
        _ => None,
    }
}

fn write_text_file_request(request: &AgentRequest) -> Option<&WriteTextFileRequest> {
    match request {
        AgentRequest::WriteTextFileRequest(request) => Some(request),
        _ => None,
    }
}

/// Resolve `requested` against `cwd` and ensure the result stays inside it.
/// Rejects relative paths that escape via `..`, absolute paths outside cwd.
async fn sandboxed_path(cwd: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        cwd.join(requested)
    };
    let normalised = normalize(&candidate);
    let cwd_normalised = normalize(cwd);
    if !normalised.starts_with(&cwd_normalised) {
        return Err(format!("path '{}' is outside the session cwd", requested));
    }
    reject_symlink_escape(cwd, &normalised, requested).await?;
    Ok(normalised)
}

async fn reject_symlink_escape(
    cwd: &Path,
    candidate: &Path,
    requested: &str,
) -> Result<(), String> {
    let canonical_cwd = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|error| format!("failed to canonicalize cwd: {error}"))?;
    let existing = nearest_existing_path(candidate).await;
    let canonical_existing = tokio::fs::canonicalize(&existing)
        .await
        .map_err(|error| format!("failed to canonicalize path parent: {error}"))?;
    if canonical_existing.starts_with(&canonical_cwd) {
        return Ok(());
    }
    Err(format!("path '{}' is outside the session cwd", requested))
}

async fn nearest_existing_path(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    loop {
        if tokio::fs::metadata(&current).await.is_ok() {
            return current;
        }
        if !current.pop() {
            return PathBuf::from(".");
        }
    }
}

/// Cheap path normalisation that resolves `.` and `..` segments. We avoid
/// `canonicalize` because the path may not exist yet (writes create it).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        apply_line_window, handle_read_text_file_raw, handle_write_text_file_raw, sandboxed_path,
        FsOutcome,
    };
    use serde_json::json;
    use tempfile::tempdir;

    #[tokio::test]
    async fn read_returns_file_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.txt");
        tokio::fs::write(&path, "hello\nworld\n").await.unwrap();
        let FsOutcome::Ok(result) =
            handle_read_text_file_raw(dir.path(), &json!({ "path": path.to_string_lossy() })).await
        else {
            panic!("expected ok");
        };
        assert_eq!(result["content"], "hello\nworld");
    }

    #[tokio::test]
    async fn read_outside_cwd_is_rejected() {
        let dir = tempdir().unwrap();
        let outside = std::env::temp_dir().join("outside-acp.txt");
        tokio::fs::write(&outside, "secret").await.unwrap();
        let FsOutcome::Error { code, message } =
            handle_read_text_file_raw(dir.path(), &json!({ "path": outside.to_string_lossy() }))
                .await
        else {
            panic!("expected error");
        };
        assert_eq!(code, -32602);
        assert!(message.contains("outside"));
    }

    #[tokio::test]
    async fn read_missing_path_is_rejected() {
        let dir = tempdir().unwrap();
        let FsOutcome::Error { code, .. } = handle_read_text_file_raw(dir.path(), &json!({})).await
        else {
            panic!("expected error");
        };
        assert_eq!(code, -32602);
    }

    #[tokio::test]
    async fn write_creates_file_and_parent_dirs() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a/b/c.txt");
        let FsOutcome::Ok(_) = handle_write_text_file_raw(
            dir.path(),
            &json!({ "path": nested.to_string_lossy(), "content": "ok" }),
        )
        .await
        else {
            panic!("expected ok");
        };
        assert_eq!(tokio::fs::read_to_string(&nested).await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn write_outside_cwd_is_rejected() {
        let dir = tempdir().unwrap();
        let outside = std::env::temp_dir().join("danger.txt");
        let FsOutcome::Error { code, .. } = handle_write_text_file_raw(
            dir.path(),
            &json!({ "path": outside.to_string_lossy(), "content": "x" }),
        )
        .await
        else {
            panic!("expected error");
        };
        assert_eq!(code, -32602);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_rejects_symlink_escape_outside_cwd() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        tokio::fs::write(&secret, "secret").await.unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();

        let FsOutcome::Error { code, message } =
            handle_read_text_file_raw(dir.path(), &json!({ "path": "escape/secret.txt" })).await
        else {
            panic!("expected symlink escape to be rejected");
        };
        assert_eq!(code, -32602);
        assert!(message.contains("outside"));
    }

    #[tokio::test]
    async fn sandboxed_path_rejects_dotdot_escape() {
        let cwd = std::path::Path::new("/work/repo");
        assert!(sandboxed_path(cwd, "../etc/passwd").await.is_err());
    }

    #[tokio::test]
    async fn sandboxed_path_accepts_relative_inside_cwd() {
        let dir = tempdir().unwrap();
        let p = sandboxed_path(dir.path(), "src/main.rs").await.unwrap();
        assert!(p.starts_with(dir.path()));
    }

    #[test]
    fn line_window_applies_offset_and_limit() {
        let content = "a\nb\nc\nd\ne\n";
        assert_eq!(apply_line_window(content, Some(2), Some(2)), "b\nc");
    }

    #[tokio::test]
    async fn typed_read_request_returns_file_contents() {
        use super::handle_read_text_file_typed;
        use agent_client_protocol::schema::v1::ReadTextFileRequest;

        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.txt");
        tokio::fs::write(&path, "hello\nworld\n").await.unwrap();
        let request = ReadTextFileRequest::new("s-1", path.clone())
            .line(1_u32)
            .limit(1_u32);

        let FsOutcome::Ok(result) = handle_read_text_file_typed(dir.path(), &request).await else {
            panic!("expected ok");
        };
        assert_eq!(result["content"], "hello");
    }

    #[tokio::test]
    async fn typed_read_outside_cwd_is_rejected() {
        use super::handle_read_text_file_typed;
        use agent_client_protocol::schema::v1::ReadTextFileRequest;

        let dir = tempdir().unwrap();
        let outside = std::env::temp_dir().join("typed-outside-acp.txt");
        let request = ReadTextFileRequest::new("s-1", outside);
        let FsOutcome::Error { code, message } =
            handle_read_text_file_typed(dir.path(), &request).await
        else {
            panic!("expected error");
        };
        assert_eq!(code, -32602);
        assert!(message.contains("outside"));
    }

    #[tokio::test]
    async fn typed_write_request_creates_file() {
        use super::handle_write_text_file_typed;
        use agent_client_protocol::schema::v1::WriteTextFileRequest;

        let dir = tempdir().unwrap();
        let path = dir.path().join("typed/write.txt");
        let request = WriteTextFileRequest::new("s-1", path.clone(), "ok");

        let FsOutcome::Ok(_) = handle_write_text_file_typed(dir.path(), &request).await else {
            panic!("expected ok");
        };
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn typed_write_outside_cwd_is_rejected() {
        use super::handle_write_text_file_typed;
        use agent_client_protocol::schema::v1::WriteTextFileRequest;

        let dir = tempdir().unwrap();
        let outside = std::env::temp_dir().join("typed-danger.txt");
        let request = WriteTextFileRequest::new("s-1", outside, "x");
        let FsOutcome::Error { code, message } =
            handle_write_text_file_typed(dir.path(), &request).await
        else {
            panic!("expected error");
        };
        assert_eq!(code, -32602);
        assert!(message.contains("outside"));
    }
}
