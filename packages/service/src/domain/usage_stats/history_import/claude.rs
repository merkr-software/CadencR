use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::types::{
    parse_timestamp, HistoryEvent, ImportBatch, ImportWindow, SessionCheckpoint, SessionSource,
};

pub fn scan(
    root: &Path,
    sources: &[SessionSource],
    window: &ImportWindow,
) -> anyhow::Result<ImportBatch> {
    if !sources.is_empty() && !root.is_dir() {
        anyhow::bail!(
            "Claude Code history directory {} is unavailable",
            root.display()
        );
    }
    let expected = sources
        .iter()
        .map(|source| source.runtime_session_id.as_str())
        .collect::<HashSet<_>>();
    let mut files_by_session = HashMap::new();
    collect_session_files(root, &expected, &mut files_by_session)?;
    let mut batch = ImportBatch::default();
    for source in sources {
        let Some(path) = files_by_session.get(&source.runtime_session_id) else {
            continue;
        };
        scan_session(path, source, window, &mut batch)?;
    }
    Ok(batch)
}

fn collect_session_files(
    directory: &Path,
    expected: &HashSet<&str>,
    files_by_session: &mut HashMap<String, PathBuf>,
) -> anyhow::Result<()> {
    let entries =
        std::fs::read_dir(directory).with_context(|| format!("read {}", directory.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("read entry in {}", directory.display()))?;
        let file_type = entry
            .file_type()
            .with_context(|| format!("read file type for {}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_session_files(&path, expected, files_by_session)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| expected.contains(stem))
        else {
            continue;
        };
        files_by_session
            .entry(session_id.to_string())
            .or_insert(path);
    }
    Ok(())
}

fn scan_session(
    path: &Path,
    source: &SessionSource,
    window: &ImportWindow,
    batch: &mut ImportBatch,
) -> anyhow::Result<()> {
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut usage_by_message_id = HashMap::<String, ClaudeUsageRow>::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some((message_id, usage)) = usage_row(&value, source, window) else {
            continue;
        };
        usage_by_message_id.insert(message_id, usage);
    }
    let totals = usage_by_message_id
        .values()
        .fold((0u64, 0u64), |totals, usage| {
            (
                totals.0.saturating_add(usage.input_tokens),
                totals.1.saturating_add(usage.output_tokens),
            )
        });
    if totals != (0, 0) {
        batch.checkpoints.push(SessionCheckpoint {
            session_id: source.session_id,
            input_tokens: totals.0,
            output_tokens: totals.1,
        });
    }
    let mut session_events = usage_by_message_id
        .into_iter()
        .filter(|(_, usage)| usage.timestamp.date_naive() >= window.start_day)
        .map(|(message_id, usage)| HistoryEvent {
            session_id: source.session_id,
            event_id: crate::domain::usage_stats::provider_message_event_id(&message_id),
            day: usage.timestamp.date_naive().to_string(),
            model_id: usage.model_id,
            thinking_effort: source.thinking_effort.clone(),
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
        })
        .collect::<Vec<_>>();
    session_events.sort_by(|left, right| left.event_id.cmp(&right.event_id));
    batch.events.extend(session_events);
    Ok(())
}

struct ClaudeUsageRow {
    timestamp: DateTime<Utc>,
    model_id: String,
    input_tokens: u64,
    output_tokens: u64,
}

fn usage_row(
    value: &Value,
    source: &SessionSource,
    window: &ImportWindow,
) -> Option<(String, ClaudeUsageRow)> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let timestamp = parse_timestamp(value.get("timestamp")?.as_str()?)?;
    // Pre-window rows seed the cumulative checkpoint, but only compact usage
    // rows are retained until the final in-window event projection.
    if timestamp > window.cutoff_at {
        return None;
    }
    let message = value.get("message")?;
    let message_id = message.get("id")?.as_str()?.to_string();
    let usage = message.get("usage")?;
    let input_tokens = token(usage, "input_tokens")
        .saturating_add(token(usage, "cache_read_input_tokens"))
        .saturating_add(token(usage, "cache_creation_input_tokens"));
    let output_tokens = token(usage, "output_tokens");
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    Some((
        message_id,
        ClaudeUsageRow {
            timestamp,
            model_id: message
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(&source.model_id)
                .to_string(),
            input_tokens,
            output_tokens,
        },
    ))
}

fn token(usage: &Value, field: &str) -> u64 {
    usage.get(field).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[test]
    fn uses_the_final_streamed_assistant_row_and_includes_cache_tokens() {
        let root = tempfile::tempdir().unwrap();
        let source = SessionSource {
            session_id: 7,
            runtime_session_id: "session-1".into(),
            model_id: "fallback".into(),
            thinking_effort: "high".into(),
        };
        let directory = root.path().join("encoded-project").join("nested");
        std::fs::create_dir_all(&directory).unwrap();
        let first = r#"{"type":"assistant","timestamp":"2026-07-20T12:00:00Z","message":{"id":"msg-1","model":"claude-opus","usage":{"input_tokens":5,"cache_read_input_tokens":10,"cache_creation_input_tokens":15,"output_tokens":8}}}"#;
        let final_snapshot = r#"{"type":"assistant","timestamp":"2026-07-20T12:00:01Z","message":{"id":"msg-1","model":"claude-opus","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":4}}}"#;
        std::fs::write(
            directory.join("session-1.jsonl"),
            format!("{first}\n{final_snapshot}\n"),
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path(), directory.join("cycle")).unwrap();
        let window = ImportWindow {
            cutoff_at: Utc.with_ymd_and_hms(2026, 7, 28, 0, 0, 0).unwrap(),
            start_day: chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap(),
        };

        let batch = scan(root.path(), &[source], &window).unwrap();

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].input_tokens, 60);
        assert_eq!(batch.events[0].output_tokens, 4);
        assert_eq!(batch.events[0].model_id, "claude-opus");
        assert_eq!(
            batch.checkpoints,
            vec![SessionCheckpoint {
                session_id: 7,
                input_tokens: 60,
                output_tokens: 4,
            }]
        );
    }
}
