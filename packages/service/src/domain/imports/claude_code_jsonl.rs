//! Parser for Claude Code's on-disk conversation history.
//!
//! Claude Code stores each session as a single JSONL file under
//! `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The encoded
//! directory name is the absolute project path with `/` replaced by `-`
//! (so `/Users/foo/bar` → `-Users-foo-bar`). Each line is a JSON event;
//! the relevant types are `user`, `assistant`, `ai-title`, plus several
//! types we deliberately ignore (`queue-operation`, `attachment`,
//! `last-prompt`).
//!
//! This module is pure — no I/O beyond reading a file path. It surfaces a
//! provider-neutral [`ImportedConversation`] that the orchestration layer
//! turns into Cadencr's `features` / `agent_sessions` / `agent_messages`
//! rows.

use std::path::{Path, PathBuf};

use super::block_extract::{extract_assistant_messages, extract_user_messages};
use super::types::truncate_title;
pub use super::types::{ImportedConversation, ImportedMessage};

/// Encode a filesystem path the way Claude Code does for its
/// `~/.claude/projects/<encoded>/` directory: drop the leading `/`, replace
/// every non-alphanumeric character (`/`, `.`, spaces, etc.) with `-`, then
/// prepend a single `-`.
///
/// Matching Claude Code exactly matters: this encoded dir is how we locate a
/// session's transcript for branching (rewind/fork context trim) and for
/// import. Replacing only `/` silently misses the `.` in paths like
/// `~/.cadencr/worktrees/...` — i.e. *every* Cadencr worktree — so the
/// transcript was never found and rewind/fork fell back to resuming the full,
/// un-trimmed history.
pub fn encode_project_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    let trimmed = s.trim_start_matches('/');
    let mut encoded = String::with_capacity(trimmed.len() + 1);
    encoded.push('-');
    for ch in trimmed.chars() {
        encoded.push(if ch.is_ascii_alphanumeric() { ch } else { '-' });
    }
    encoded
}

/// Resolve the directory Claude Code would use for a given project path,
/// rooted at `~/.claude/projects/`. Returns `None` if the home dir can't
/// be resolved — callers should treat that as "no conversations".
pub fn claude_projects_dir_for(project_path: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".claude")
            .join("projects")
            .join(encode_project_path(project_path)),
    )
}

/// Scan all `*.jsonl` files directly under the given dir. Subdirectories
/// (e.g. `subagents/`) are skipped: those are nested agent transcripts that
/// don't represent the top-level user-facing session. Returns `Ok(vec![])`
/// if the directory doesn't exist — an empty list is a normal state.
pub fn list_session_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    Ok(out)
}

/// Parse a JSONL file into an [`ImportedConversation`]. Malformed lines are
/// logged and skipped — we never fail the whole session because of a
/// truncated tail or stray non-JSON line. Returns `Ok(None)` for sessions
/// with zero user/assistant messages (they're useless to import).
pub fn parse_session_file(path: &Path) -> std::io::Result<Option<ImportedConversation>> {
    let raw = std::fs::read_to_string(path)?;
    let source_session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let mut ai_title: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    let mut messages: Vec<ImportedMessage> = Vec::new();
    let mut last_timestamp: Option<String> = None;
    let mut first_timestamp: Option<String> = None;

    for (line_no, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    file = %path.display(),
                    line = line_no + 1,
                    error = %err,
                    "skipping malformed JSONL line"
                );
                continue;
            }
        };

        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from);
        if let Some(ts) = &ts {
            if first_timestamp.is_none() {
                first_timestamp = Some(ts.clone());
            }
            last_timestamp = Some(ts.clone());
        }

        match kind {
            "ai-title" => {
                if let Some(t) = value.get("aiTitle").and_then(|v| v.as_str()) {
                    ai_title = Some(t.to_string());
                }
            }
            "user" => {
                extract_user_messages(&value, ts.as_deref(), &mut messages, &mut first_user_text);
            }
            "assistant" => {
                extract_assistant_messages(&value, ts.as_deref(), &mut messages);
            }
            _ => {}
        }
    }

    if messages.is_empty() {
        return Ok(None);
    }

    let title = ai_title
        .or_else(|| first_user_text.map(|t| truncate_title(&t)))
        .unwrap_or_else(|| {
            let prefix: String = source_session_id.chars().take(8).collect();
            format!("Claude Code session {prefix}")
        });

    Ok(Some(ImportedConversation {
        source_session_id,
        title,
        model: messages.iter().find_map(|msg| msg.model.clone()),
        started_at: first_timestamp.clone(),
        modified_at: last_timestamp.or(first_timestamp),
        messages,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::imports::types::DERIVED_TITLE_MAX_CHARS;
    use std::io::Write;

    #[test]
    fn encode_project_path_replaces_every_non_alphanumeric() {
        // Slashes AND spaces collapse to '-' (Claude Code's rule).
        let p = Path::new("/Users/foo/bar baz/proj");
        assert_eq!(encode_project_path(p), "-Users-foo-bar-baz-proj");
    }

    #[test]
    fn encode_project_path_collapses_dot_dirs() {
        // Regression: `~/.cadencr/...` must encode the dot as '-' (so the
        // leading `/.cadencr` becomes `--cadencr`), matching the on-disk dir
        // Claude Code actually writes — otherwise branching can't find the
        // transcript.
        let p = Path::new("/Users/rle/.cadencr/worktrees/cadencr/feature-x-5d03");
        assert_eq!(
            encode_project_path(p),
            "-Users-rle--cadencr-worktrees-cadencr-feature-x-5d03"
        );
    }

    #[test]
    fn encode_project_path_handles_root_only() {
        assert_eq!(encode_project_path(Path::new("/")), "-");
    }

    #[test]
    fn truncate_title_keeps_short_text_verbatim() {
        assert_eq!(truncate_title("hello"), "hello");
    }

    #[test]
    fn truncate_title_uses_first_line() {
        assert_eq!(truncate_title("first\nsecond"), "first");
    }

    #[test]
    fn truncate_title_caps_long_text_with_ellipsis() {
        let long: String = "a".repeat(200);
        let out = truncate_title(&long);
        assert_eq!(out.chars().count(), DERIVED_TITLE_MAX_CHARS);
        assert!(out.ends_with('…'));
    }

    fn write_jsonl(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut file = tempfile::Builder::new()
            .suffix(".jsonl")
            .tempfile()
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        file.flush().unwrap();
        file
    }

    #[test]
    fn parse_session_file_returns_none_for_zero_messages() {
        let file = write_jsonl(&[
            r#"{"type":"attachment","payload":{}}"#,
            r#"{"type":"ai-title","aiTitle":"x","sessionId":"s"}"#,
        ]);
        let result = parse_session_file(file.path()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn parse_session_file_picks_ai_title_over_first_user_message() {
        let file = write_jsonl(&[
            r#"{"type":"user","message":{"role":"user","content":"hello there"},"timestamp":"2026-05-27T19:56:38.828Z"}"#,
            r#"{"type":"ai-title","aiTitle":"Real title"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude","content":[{"type":"text","text":"hi"}]}}"#,
        ]);
        let conv = parse_session_file(file.path()).unwrap().unwrap();
        assert_eq!(conv.title, "Real title");
        assert_eq!(conv.model.as_deref(), Some("claude"));
        assert_eq!(conv.messages.len(), 2);
        assert!(conv.modified_at.is_some());
    }

    #[test]
    fn parse_session_file_falls_back_to_first_user_text() {
        let file = write_jsonl(&[
            r#"{"type":"user","message":{"role":"user","content":"my first question"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude","content":[{"type":"text","text":"hi"}]}}"#,
        ]);
        let conv = parse_session_file(file.path()).unwrap().unwrap();
        assert_eq!(conv.title, "my first question");
    }

    #[test]
    fn parse_session_file_extracts_tool_use_and_tool_result() {
        let file = write_jsonl(&[
            r#"{"type":"user","message":{"role":"user","content":"go"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"cmd":"ls"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"file1\nfile2"}]}}"#,
        ]);
        let conv = parse_session_file(file.path()).unwrap().unwrap();
        assert_eq!(conv.messages.len(), 3);
        assert_eq!(conv.messages[1].message_type, "tool_call");
        assert_eq!(conv.messages[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(conv.messages[1].tool_use_id.as_deref(), Some("tu1"));
        assert_eq!(conv.messages[1].model.as_deref(), Some("claude-opus"));
        assert_eq!(conv.messages[2].message_type, "tool_result");
        assert_eq!(conv.messages[2].role, "tool");
        assert_eq!(conv.messages[2].tool_use_id.as_deref(), Some("tu1"));
    }

    #[test]
    fn parse_session_file_tolerates_malformed_lines() {
        let file = write_jsonl(&[
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"this is not json"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}"#,
        ]);
        let conv = parse_session_file(file.path()).unwrap().unwrap();
        assert_eq!(conv.messages.len(), 2);
    }

    #[test]
    fn parse_session_file_marks_tool_errors() {
        let file = write_jsonl(&[
            r#"{"type":"user","message":{"role":"user","content":"go"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"boom"}]}}"#,
        ]);
        let conv = parse_session_file(file.path()).unwrap().unwrap();
        assert_eq!(conv.messages[1].message_type, "tool_error");
    }

    #[test]
    fn list_session_files_returns_empty_when_missing() {
        let result = list_session_files(Path::new("/nonexistent/path/xyz")).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_session_files_skips_non_jsonl_and_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("b.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("subagents")).unwrap();
        let result = list_session_files(dir.path()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".jsonl"));
    }
}
