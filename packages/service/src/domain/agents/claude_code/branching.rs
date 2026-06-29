//! Claude Code's `SessionBranching` implementation: point-in-time transcript
//! surgery over the on-disk JSONL session file.
//!
//! `truncate_before` copies the prefix of a session's transcript up to the cut
//! point into a fresh `<new-uuid>.jsonl` (same projects dir, so `--resume` finds
//! it), rewriting `sessionId` so the new id is self-consistent. The original
//! session file is never modified, so fork leaves the source intact and rewind's
//! own DB swap is what makes the change visible.

use std::io::Write;
use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;

use crate::domain::agents::adapter::{BranchContext, BranchError, BranchResult, SessionBranching};
use crate::domain::imports::claude_code_jsonl::claude_projects_dir_for;

use super::jsonl_surgery;

/// Zero-sized capability handle returned from
/// `ClaudeCodeAdapter::session_branching`.
pub(super) struct ClaudeSessionBranching;

#[async_trait]
impl SessionBranching for ClaudeSessionBranching {
    async fn truncate_before(&self, ctx: &BranchContext) -> Result<BranchResult, BranchError> {
        let dir = claude_projects_dir_for(&ctx.cwd).ok_or_else(|| {
            BranchError::Unsupported("could not resolve Claude projects dir".to_string())
        })?;
        let source = dir.join(format!("{}.jsonl", ctx.source_runtime_session_id));

        let raw = std::fs::read_to_string(&source).map_err(|e| {
            BranchError::Unsupported(format!(
                "transcript not readable ({}): {e}",
                source.display()
            ))
        })?;

        let lines = parse_lines(&raw)?;
        if lines.is_empty() || !jsonl_surgery::looks_like_transcript(&lines) {
            return Err(BranchError::Surgery(
                "transcript is empty or not a recognized Claude session file".to_string(),
            ));
        }

        let cut = jsonl_surgery::resolve_cut_index(
            &lines,
            ctx.cut_provider_uuid.as_deref(),
            ctx.cut_user_ordinal,
        )
        .ok_or_else(|| {
            BranchError::Surgery(format!(
                "could not locate cut point (ordinal {})",
                ctx.cut_user_ordinal
            ))
        })?;

        let new_id = uuid::Uuid::new_v4().to_string();
        let body = jsonl_surgery::rewrite_session_id(&lines[..cut], &new_id);
        let dest = dir.join(format!("{new_id}.jsonl"));
        write_atomic(&dest, &body).map_err(|e| {
            BranchError::Surgery(format!("could not write branched transcript: {e}"))
        })?;

        Ok(BranchResult {
            new_runtime_session_id: new_id,
        })
    }
}

/// Parse the JSONL, tolerating only a malformed *final* line (a transcript whose
/// last line was half-written when we read it). A malformed line anywhere before
/// the end means mid-file corruption: failing is safer than silently dropping
/// it, which would shift `cut_user_ordinal` and branch the wrong context.
fn parse_lines(raw: &str) -> Result<Vec<Value>, BranchError> {
    let raw_lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let mut parsed = Vec::with_capacity(raw_lines.len());
    for (idx, line) in raw_lines.iter().enumerate() {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => parsed.push(value),
            Err(error) => {
                if idx == raw_lines.len() - 1 {
                    break; // a truncated tail line is expected; drop it
                }
                return Err(BranchError::Surgery(format!(
                    "malformed transcript at line {} of {}: {error}",
                    idx + 1,
                    raw_lines.len()
                )));
            }
        }
    }
    Ok(parsed)
}

/// Write `body` to `dest` atomically (temp file in the same dir + rename) so a
/// concurrent reader never sees a half-written transcript.
fn write_atomic(dest: &Path, body: &str) -> std::io::Result<()> {
    let dir = dest.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no parent dir",
        )
    })?;
    let tmp = dir.join(format!(
        ".cadencr-branch-{}.tmp",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("x")
    ));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
    }
    std::fs::rename(&tmp, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::shared::test_env::{async_env_lock, EnvVarGuard};

    /// Point `claude_projects_dir_for` at a temp tree by overriding HOME. The
    /// caller must already hold the env lock; the returned guard restores HOME
    /// (and keeps the tempdir alive) for the rest of the test.
    fn set_home(home: tempfile::TempDir) -> (tempfile::TempDir, EnvVarGuard) {
        let guard = EnvVarGuard::set("HOME", home.path().to_str().unwrap());
        (home, guard)
    }

    /// Build a temp projects dir + transcript for `cwd` under the current HOME.
    fn write_transcript(cwd: &Path, session_id: &str, lines: &[Value]) {
        let dir = claude_projects_dir_for(cwd).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = String::new();
        for line in lines {
            body.push_str(&serde_json::to_string(line).unwrap());
            body.push('\n');
        }
        std::fs::write(dir.join(format!("{session_id}.jsonl")), body).unwrap();
    }

    #[tokio::test]
    async fn truncate_before_writes_a_prefixed_transcript_under_a_new_id() {
        let _env = async_env_lock().lock().await;
        let (_home, _home_guard) = set_home(tempfile::tempdir().unwrap());
        let cwd = Path::new("/Users/test/proj");
        let lines = vec![
            json!({"type": "user", "uuid": "p1", "sessionId": "src", "message": {"role": "user", "content": "first"}}),
            json!({"type": "assistant", "uuid": "a1", "sessionId": "src", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}}),
            json!({"type": "user", "uuid": "p2", "sessionId": "src", "message": {"role": "user", "content": "second"}}),
            json!({"type": "assistant", "uuid": "a2", "sessionId": "src", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}}),
        ];
        write_transcript(cwd, "src", &lines);

        let ctx = BranchContext {
            cwd: cwd.to_path_buf(),
            source_runtime_session_id: "src".to_string(),
            cut_provider_uuid: None,
            cut_user_ordinal: 2, // cut before the 2nd prompt → keep p1, a1
        };
        let result = ClaudeSessionBranching.truncate_before(&ctx).await.unwrap();

        let dir = claude_projects_dir_for(cwd).unwrap();
        let new_path = dir.join(format!("{}.jsonl", result.new_runtime_session_id));
        let kept = std::fs::read_to_string(&new_path).unwrap();
        let kept_lines: Vec<Value> = kept
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(kept_lines.len(), 2, "only the pre-cut prefix is kept");
        assert_eq!(kept_lines[0]["uuid"], "p1");
        for line in &kept_lines {
            assert_eq!(line["sessionId"], result.new_runtime_session_id);
        }
        // Source transcript is untouched (fork must not disturb the origin).
        assert!(dir.join("src.jsonl").exists());
    }

    #[tokio::test]
    async fn truncate_before_errors_when_transcript_missing() {
        let _env = async_env_lock().lock().await;
        let (_home, _home_guard) = set_home(tempfile::tempdir().unwrap());
        let ctx = BranchContext {
            cwd: Path::new("/Users/test/missing").to_path_buf(),
            source_runtime_session_id: "nope".to_string(),
            cut_provider_uuid: None,
            cut_user_ordinal: 1,
        };
        let err = ClaudeSessionBranching
            .truncate_before(&ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, BranchError::Unsupported(_)), "{err}");
    }

    #[tokio::test]
    async fn truncate_before_tolerates_a_malformed_tail_line() {
        let _env = async_env_lock().lock().await;
        let (_home, _home_guard) = set_home(tempfile::tempdir().unwrap());
        let cwd = Path::new("/Users/test/proj2");
        let lines = vec![
            json!({"type": "user", "uuid": "p1", "sessionId": "src", "message": {"role": "user", "content": "first"}}),
            json!({"type": "assistant", "uuid": "a1", "sessionId": "src", "message": {"role": "assistant", "content": []}}),
            json!({"type": "user", "uuid": "p2", "sessionId": "src", "message": {"role": "user", "content": "second"}}),
        ];
        write_transcript(cwd, "src", &lines);
        // Append a non-JSON line.
        let dir = claude_projects_dir_for(cwd).unwrap();
        let path = dir.join("src.jsonl");
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("this is not json\n");
        std::fs::write(&path, content).unwrap();

        let ctx = BranchContext {
            cwd: cwd.to_path_buf(),
            source_runtime_session_id: "src".to_string(),
            cut_provider_uuid: Some("p2".to_string()),
            cut_user_ordinal: 2,
        };
        let result = ClaudeSessionBranching.truncate_before(&ctx).await.unwrap();
        let new_path = dir.join(format!("{}.jsonl", result.new_runtime_session_id));
        let kept = std::fs::read_to_string(new_path).unwrap();
        assert_eq!(kept.lines().count(), 2);
    }

    #[tokio::test]
    async fn truncate_before_rejects_a_malformed_middle_line() {
        let _env = async_env_lock().lock().await;
        let (_home, _home_guard) = set_home(tempfile::tempdir().unwrap());
        let cwd = Path::new("/Users/test/proj3");
        let dir = claude_projects_dir_for(cwd).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        // A malformed line BEFORE the cut would shift the ordinal — surgery must
        // refuse it rather than silently drop it.
        let body = format!(
            "{}\nthis is not json\n{}\n",
            serde_json::json!({"type": "user", "uuid": "p1", "sessionId": "src", "message": {"role": "user", "content": "first"}}),
            serde_json::json!({"type": "user", "uuid": "p2", "sessionId": "src", "message": {"role": "user", "content": "second"}}),
        );
        std::fs::write(dir.join("src.jsonl"), body).unwrap();

        let ctx = BranchContext {
            cwd: cwd.to_path_buf(),
            source_runtime_session_id: "src".to_string(),
            cut_provider_uuid: None,
            cut_user_ordinal: 2,
        };
        let err = ClaudeSessionBranching
            .truncate_before(&ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, BranchError::Surgery(_)), "{err}");
    }
}
