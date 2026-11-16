//! Command conditions: a schedule that only delivers when a shell command
//! fails.
//!
//! The recurrence still decides *when* the schedule is evaluated; the condition
//! decides *whether* that evaluation sends anything. A zero exit means "all
//! good, stay quiet"; anything else delivers the prompt with the command's
//! output appended, so the agent starts from the failure rather than having to
//! reproduce it.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use super::models::{ScheduleCheckStatus, ScheduleCondition};
use crate::error::AppError;
use crate::shared::bounded_command::capture_tail;

/// Long enough for a typical test suite, short enough that a hung command is
/// noticed within the hour.
pub const DEFAULT_TIMEOUT_SECONDS: i64 = 300;

/// Bounded so a claim plus a triggered dispatch always fits inside the stale
/// claim window (see `repository::claim`) — a longer check would let another
/// pass take the row over mid-evaluation and evaluate it twice.
pub const MAX_TIMEOUT_SECONDS: i64 = 600;

/// How much output rides along with the prompt. Failures are reported at the
/// end of a run, so it is the tail that is kept.
const MAX_PROMPT_OUTPUT_CHARS: usize = 8_000;

/// One evaluation, ready to be written to the schedule row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckRecord {
    pub status: ScheduleCheckStatus,
    pub exit_code: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Evaluation {
    Passed,
    Failed {
        /// `None` when the command was killed by a signal.
        exit_code: Option<i32>,
        output: String,
    },
    Error(String),
}

/// Validate a condition before it is stored, so a schedule that can never be
/// evaluated is refused at save time instead of failing on every tick.
pub fn normalize(
    condition: Option<ScheduleCondition>,
) -> Result<Option<ScheduleCondition>, AppError> {
    let Some(condition) = condition else {
        return Ok(None);
    };
    let command = condition.command.trim().to_string();
    if command.is_empty() {
        return Err(AppError::BadRequest(
            "a command is required to trigger on its failure".into(),
        ));
    }
    if let Some(seconds) = condition.timeout_seconds {
        if !(1..=MAX_TIMEOUT_SECONDS).contains(&seconds) {
            return Err(AppError::BadRequest(format!(
                "timeout_seconds must be between 1 and {MAX_TIMEOUT_SECONDS}"
            )));
        }
    }
    Ok(Some(ScheduleCondition {
        command,
        timeout_seconds: condition.timeout_seconds,
    }))
}

/// Run the condition's command in `cwd` and classify the result.
pub async fn evaluate(condition: &ScheduleCondition, cwd: &Path) -> Evaluation {
    // In range: `normalize` validates every write path.
    let seconds = condition.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    let mut command = crate::shared::user_shell::command(&condition.command, cwd);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match capture_tail(command, Duration::from_secs(seconds as u64)).await {
        Ok(output) if output.status.success() => Evaluation::Passed,
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.trim().is_empty() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&stderr);
            }
            Evaluation::Failed {
                exit_code: output.status.code(),
                output: text,
            }
        }
        Err(error) => Evaluation::Error(format!("trigger command {error}")),
    }
}

/// The prompt actually delivered when the command failed: the user's prompt,
/// then what failed and the tail of its output.
pub fn triggered_prompt(
    prompt: &str,
    command: &str,
    exit_code: Option<i32>,
    output: &str,
) -> String {
    let status = match exit_code {
        Some(code) => format!("exited with code {code}"),
        None => "was terminated by a signal".to_string(),
    };
    let output = output.trim_end();
    if output.is_empty() {
        return format!("{prompt}\n\n---\nTriggered because `{command}` {status} (no output).");
    }
    let (tail, clipped) = tail_chars(output, MAX_PROMPT_OUTPUT_CHARS);
    let label = if clipped {
        format!("Output (last {MAX_PROMPT_OUTPUT_CHARS} characters)")
    } else {
        "Output".to_string()
    };
    let fence = fence_for(tail);
    format!("{prompt}\n\n---\nTriggered because `{command}` {status}. {label}:\n\n{fence}text\n{tail}\n{fence}")
}

/// The last `max` characters of `text`, and whether anything was cut.
fn tail_chars(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().rev().nth(max) {
        None => (text, false),
        Some((index, ch)) => (&text[index + ch.len_utf8()..], true),
    }
}

/// A code fence longer than any backtick run in `body`, so output that itself
/// contains a fence can't close ours early.
fn fence_for(body: &str) -> String {
    let mut longest = 0;
    let mut current = 0;
    for ch in body.chars() {
        if ch == '`' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    "`".repeat(longest.max(2) + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn condition(command: &str, timeout_seconds: Option<i64>) -> ScheduleCondition {
        ScheduleCondition {
            command: command.into(),
            timeout_seconds,
        }
    }

    #[test]
    fn normalize_trims_and_rejects_unusable_conditions() {
        assert_eq!(normalize(None).unwrap(), None);
        assert_eq!(
            normalize(Some(condition("  make test \n", Some(30)))).unwrap(),
            Some(condition("make test", Some(30)))
        );
        assert!(normalize(Some(condition("   ", None))).is_err());
        assert!(normalize(Some(condition("true", Some(0)))).is_err());
        assert!(normalize(Some(condition("true", Some(MAX_TIMEOUT_SECONDS + 1)))).is_err());
    }

    #[tokio::test]
    async fn a_zero_exit_passes_and_anything_else_fails_with_its_output() {
        let cwd = std::env::temp_dir();
        assert_eq!(
            evaluate(&condition("exit 0", None), &cwd).await,
            Evaluation::Passed
        );
        let Evaluation::Failed { exit_code, output } =
            evaluate(&condition("echo out; echo err >&2; exit 3", None), &cwd).await
        else {
            panic!("expected a failure");
        };
        assert_eq!(exit_code, Some(3));
        assert!(output.contains("out"), "{output}");
        assert!(output.contains("err"), "{output}");
    }

    #[tokio::test]
    async fn the_command_runs_in_the_given_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker"), "").unwrap();
        assert_eq!(
            evaluate(&condition("test -f marker", None), dir.path()).await,
            Evaluation::Passed
        );
    }

    #[tokio::test]
    async fn a_hung_command_is_an_error_not_a_trigger() {
        let result = evaluate(&condition("sleep 5", Some(1)), &std::env::temp_dir()).await;
        let Evaluation::Error(message) = result else {
            panic!("expected an error, got {result:?}");
        };
        assert!(message.contains("timed out"), "{message}");
    }

    #[test]
    fn the_triggered_prompt_carries_the_failure_tail() {
        let prompt = triggered_prompt("Fix the tests.", "cargo test", Some(101), "a\nb\n");
        assert!(prompt.starts_with("Fix the tests.\n\n---\n"));
        assert!(prompt.contains("`cargo test` exited with code 101. Output:"));
        assert!(prompt.ends_with("```text\na\nb\n```"));

        let long = "x".repeat(MAX_PROMPT_OUTPUT_CHARS + 10) + "END";
        let clipped = triggered_prompt("p", "c", None, &long);
        assert!(clipped.contains("was terminated by a signal"));
        assert!(clipped.contains(&format!("last {MAX_PROMPT_OUTPUT_CHARS} characters")));
        assert!(clipped.contains("END"));

        let silent = triggered_prompt("p", "c", Some(1), "  \n");
        assert!(silent.ends_with("exited with code 1 (no output)."));
    }

    #[test]
    fn the_tail_counts_characters_not_bytes() {
        assert_eq!(tail_chars("héllo", 5), ("héllo", false));
        assert_eq!(tail_chars("héllo", 4), ("éllo", true));
        assert_eq!(tail_chars("", 3), ("", false));
    }

    #[test]
    fn output_containing_a_fence_gets_a_longer_one() {
        let prompt = triggered_prompt("p", "c", Some(1), "```\ninner\n```");
        assert!(
            prompt.contains("````text\n```\ninner\n```\n````"),
            "{prompt}"
        );
    }
}
