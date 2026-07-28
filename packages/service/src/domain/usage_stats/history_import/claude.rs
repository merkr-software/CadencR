use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::Value;

use super::types::{parse_timestamp, HistoryEvent, ImportBatch, ImportWindow, SessionSource};

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
        scan_session(path, source, window, &mut batch.events)?;
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
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, expected, files_by_session)?;
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
    events: &mut Vec<HistoryEvent>,
) -> anyhow::Result<()> {
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut seen_message_ids = HashSet::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(event) = history_event(&value, source, window, &mut seen_message_ids) else {
            continue;
        };
        events.push(event);
    }
    Ok(())
}

fn history_event(
    value: &Value,
    source: &SessionSource,
    window: &ImportWindow,
    seen_message_ids: &mut HashSet<String>,
) -> Option<HistoryEvent> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let timestamp = parse_timestamp(value.get("timestamp")?.as_str()?)?;
    if !window.contains(timestamp) {
        return None;
    }
    let message = value.get("message")?;
    let message_id = message.get("id")?.as_str()?.to_string();
    if !seen_message_ids.insert(message_id.clone()) {
        return None;
    }
    let usage = message.get("usage")?;
    let input_tokens = token(usage, "input_tokens")
        .saturating_add(token(usage, "cache_read_input_tokens"))
        .saturating_add(token(usage, "cache_creation_input_tokens"));
    let output_tokens = token(usage, "output_tokens");
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    Some(HistoryEvent {
        session_id: source.session_id,
        event_id: format!("history:claude:{message_id}"),
        day: timestamp.date_naive().to_string(),
        model_id: message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(&source.model_id)
            .to_string(),
        thinking_effort: source.thinking_effort.clone(),
        input_tokens,
        output_tokens,
    })
}

fn token(usage: &Value, field: &str) -> u64 {
    usage.get(field).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[test]
    fn deduplicates_streamed_assistant_rows_and_includes_cache_tokens() {
        let root = tempfile::tempdir().unwrap();
        let source = SessionSource {
            session_id: 7,
            runtime_session_id: "session-1".into(),
            model_id: "fallback".into(),
            thinking_effort: "high".into(),
        };
        let directory = root.path().join("encoded-project").join("nested");
        std::fs::create_dir_all(&directory).unwrap();
        let line = r#"{"type":"assistant","timestamp":"2026-07-20T12:00:00Z","message":{"id":"msg-1","model":"claude-opus","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":4}}}"#;
        std::fs::write(
            directory.join("session-1.jsonl"),
            format!("{line}\n{line}\n"),
        )
        .unwrap();
        let window = ImportWindow {
            cutoff_at: Utc.with_ymd_and_hms(2026, 7, 28, 0, 0, 0).unwrap(),
            start_day: chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap(),
        };

        let batch = scan(root.path(), &[source], &window).unwrap();

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].input_tokens, 60);
        assert_eq!(batch.events[0].output_tokens, 4);
        assert_eq!(batch.events[0].model_id, "claude-opus");
    }
}
