use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::Context;
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
        anyhow::bail!("Codex history directory {} is unavailable", root.display());
    }
    let files = rollout_files(root)?;
    let files_by_session = files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_stem()?.to_str()?;
            let source = sources
                .iter()
                .find(|source| name.ends_with(&source.runtime_session_id))?;
            Some((source.runtime_session_id.clone(), path))
        })
        .collect::<HashMap<_, _>>();
    let mut batch = ImportBatch::default();
    for source in sources {
        let Some(path) = files_by_session.get(&source.runtime_session_id) else {
            continue;
        };
        scan_rollout(path, source, window, &mut batch)?;
    }
    Ok(batch)
}

fn rollout_files(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_rollouts(root, &mut files)?;
    Ok(files)
}

fn collect_rollouts(directory: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    let entries =
        std::fs::read_dir(directory).with_context(|| format!("read {}", directory.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("read entry in {}", directory.display()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, files)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn scan_rollout(
    path: &Path,
    source: &SessionSource,
    window: &ImportWindow,
    batch: &mut ImportBatch,
) -> anyhow::Result<()> {
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut model_id = source.model_id.clone();
    let mut thinking_effort = source.thinking_effort.clone();
    let mut previous = (0, 0);
    let mut latest = None;
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            update_turn_context(payload, &mut model_id, &mut thinking_effort);
            continue;
        }
        let Some(timestamp) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp)
        else {
            continue;
        };
        if timestamp > window.cutoff_at {
            continue;
        }
        let Some(current) = cumulative_tokens(payload) else {
            continue;
        };
        let delta = (
            current.0.saturating_sub(previous.0),
            current.1.saturating_sub(previous.1),
        );
        previous = current;
        latest = Some(current);
        if !window.contains(timestamp) || delta == (0, 0) {
            continue;
        }
        batch.events.push(HistoryEvent {
            session_id: source.session_id,
            event_id: format!("history:codex:{line_index}:{}", timestamp.to_rfc3339()),
            day: timestamp.date_naive().to_string(),
            model_id: model_id.clone(),
            thinking_effort: thinking_effort.clone(),
            input_tokens: delta.0,
            output_tokens: delta.1,
        });
    }
    if let Some((input_tokens, output_tokens)) = latest {
        batch.checkpoints.push(SessionCheckpoint {
            session_id: source.session_id,
            input_tokens,
            output_tokens,
        });
    }
    Ok(())
}

fn update_turn_context(payload: &Value, model_id: &mut String, thinking_effort: &mut String) {
    if let Some(model) = payload.get("model").and_then(Value::as_str) {
        *model_id = model.to_string();
    }
    if let Some(effort) = payload
        .get("effort")
        .or_else(|| payload.get("reasoning_effort"))
        .and_then(Value::as_str)
    {
        *thinking_effort = effort.to_string();
    }
}

fn cumulative_tokens(payload: &Value) -> Option<(u64, u64)> {
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let total = payload.get("info")?.get("total_token_usage")?;
    Some((
        total.get("input_tokens")?.as_u64()?,
        total.get("output_tokens")?.as_u64()?,
    ))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[test]
    fn imports_window_deltas_and_seeds_the_full_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("2026").join("07").join("20");
        std::fs::create_dir_all(&directory).unwrap();
        let session_id = "019f2948-8e1b-7892-8409-0529e5d5e268";
        let file = directory.join(format!("rollout-2026-07-20T00-00-00-{session_id}.jsonl"));
        std::fs::write(
            file,
            concat!(
                "{\"timestamp\":\"2026-06-20T00:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":10}}}}\n",
                "{\"timestamp\":\"2026-07-20T00:00:00Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6\",\"effort\":\"high\"}}\n",
                "{\"timestamp\":\"2026-07-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":150,\"output_tokens\":20}}}}\n"
            ),
        )
        .unwrap();
        let source = SessionSource {
            session_id: 9,
            runtime_session_id: session_id.into(),
            model_id: "fallback".into(),
            thinking_effort: "low".into(),
        };
        let window = ImportWindow {
            cutoff_at: Utc.with_ymd_and_hms(2026, 7, 28, 0, 0, 0).unwrap(),
            start_day: chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap(),
        };

        let batch = scan(root.path(), &[source], &window).unwrap();

        assert_eq!(batch.events.len(), 1);
        assert_eq!(
            (batch.events[0].input_tokens, batch.events[0].output_tokens),
            (50, 10)
        );
        assert_eq!(batch.events[0].model_id, "gpt-5.6");
        assert_eq!(batch.events[0].thinking_effort, "high");
        assert_eq!(
            batch.checkpoints,
            vec![SessionCheckpoint {
                session_id: 9,
                input_tokens: 150,
                output_tokens: 20
            }]
        );
    }
}
