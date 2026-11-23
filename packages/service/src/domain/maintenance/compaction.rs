//! The lossy transform used by archived-feature retention.
//!
//! Retention may persist only the exact Bash-output truncation already applied
//! on the read path. Reusing that implementation is intentional: it prevents a
//! maintenance sweep from trimming nested JSON, tool arguments, content blocks,
//! or output from tools that the UI otherwise shows in full.

use crate::domain::sessions::repository::truncation::{
    is_bash_tool_name, truncate_bash_output, BASH_OUTPUT_MAX_LINES,
};

use tokio::task::JoinError;

pub(super) struct CompactedSnapshot {
    pub original: String,
    pub replacement: String,
}

/// Why compacting a feature stopped: its rows could not be read or written,
/// or the off-runtime compaction of one message panicked.
#[derive(Debug, thiserror::Error)]
pub(super) enum CompactionError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("compaction task failed: {0}")]
    Task(#[source] JoinError),
}

/// Return the read-path representation when it is shorter, otherwise `None`.
pub fn compact_content(content: &str, tool_name: Option<&str>) -> Option<String> {
    if !is_bash_tool_name(tool_name) {
        return None;
    }

    let (truncated, was_truncated) = truncate_bash_output(content, BASH_OUTPUT_MAX_LINES);
    was_truncated.then_some(truncated)
}

/// Keep large JSON/string work off the async runtime while preserving the exact
/// snapshot that produced the compacted value. The retention writer uses that
/// snapshot for a compare-and-set update, so a live shell cannot be overwritten
/// by work computed from older output. `Ok(None)`: nothing to compact.
pub(super) async fn compact_bash_content_async(
    content: String,
) -> Result<Option<CompactedSnapshot>, CompactionError> {
    off_runtime(move || {
        compact_content(&content, Some("Bash")).map(|replacement| CompactedSnapshot {
            original: content,
            replacement,
        })
    })
    .await
}

/// A panic in `work` fails the feature's compaction instead of reading as
/// "nothing to compact".
async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, CompactionError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(CompactionError::Task)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn huge_log() -> String {
        (0..5_000)
            .map(|line| format!("line {line} of a very long build log"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn a_panicking_compaction_is_an_error_not_a_skipped_message() {
        let result =
            off_runtime(|| -> Option<CompactedSnapshot> { panic!("transform exploded") }).await;
        let error = result
            .err()
            .expect("a panic must not read as nothing to compact");
        assert!(matches!(error, CompactionError::Task(_)), "{error:?}");
        assert!(
            error.to_string().starts_with("compaction task failed: "),
            "{error}"
        );
    }

    #[tokio::test]
    async fn compacts_a_long_bash_output_off_the_runtime() {
        let snapshot = compact_bash_content_async(huge_log())
            .await
            .unwrap()
            .expect("a long bash log is compacted");
        assert_eq!(snapshot.original, huge_log());
        assert!(snapshot.replacement.len() < snapshot.original.len());
        assert!(compact_bash_content_async("short".into())
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn persists_exactly_the_bash_read_path_representation() {
        let content = serde_json::json!({
            "command": "pnpm build",
            "aggregatedOutput": huge_log(),
        })
        .to_string();
        let (displayed, was_truncated) = truncate_bash_output(&content, BASH_OUTPUT_MAX_LINES);

        assert!(was_truncated);
        assert_eq!(compact_content(&content, Some("Bash")), Some(displayed));
    }

    #[test]
    fn leaves_nested_and_content_block_text_untouched() {
        for content in [
            serde_json::json!({ "result": { "text": huge_log() } }).to_string(),
            serde_json::json!([{ "type": "text", "text": huge_log() }]).to_string(),
        ] {
            assert!(compact_content(&content, Some("Bash")).is_none());
        }
    }

    #[test]
    fn truncates_bare_bash_output_exactly_like_the_read_path() {
        let content = huge_log();
        let expected = truncate_bash_output(&content, BASH_OUTPUT_MAX_LINES).0;

        assert_eq!(compact_content(&content, Some("Bash")), Some(expected));
    }

    #[test]
    fn leaves_non_bash_tools_and_arguments_untouched() {
        let output = serde_json::json!({ "output": huge_log() }).to_string();
        let arguments = serde_json::json!({ "command": huge_log() }).to_string();

        assert!(compact_content(&output, Some("Read")).is_none());
        assert!(compact_content(&output, None).is_none());
        assert!(compact_content(&arguments, Some("Bash")).is_none());
    }

    #[test]
    fn is_idempotent() {
        let content = serde_json::json!({ "output": huge_log() }).to_string();
        let once = compact_content(&content, Some("Bash")).expect("first pass compacts");

        assert!(compact_content(&once, Some("Bash")).is_none());
    }
}
