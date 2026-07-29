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
    let mut files_by_session = HashMap::<String, Vec<PathBuf>>::new();
    for path in crate::domain::imports::list_codex_rollout_files(root)? {
        let matched = (|| {
            let name = path.file_stem()?.to_str()?;
            let source = sources.iter().find(|source| {
                name.strip_suffix(&source.runtime_session_id)
                    .is_some_and(|prefix| prefix.ends_with('-'))
            })?;
            Some(source.runtime_session_id.clone())
        })();
        if let Some(session_id) = matched {
            files_by_session.entry(session_id).or_default().push(path);
        }
    }
    let mut batch = ImportBatch::default();
    for source in sources {
        let Some(paths) = files_by_session.get(&source.runtime_session_id) else {
            continue;
        };
        let mut state = RolloutState::new(source);
        for path in paths {
            scan_rollout(path, source, window, &mut state, &mut batch.events)?;
        }
        if let Some((input_tokens, output_tokens)) = state.total {
            batch.checkpoints.push(SessionCheckpoint {
                session_id: source.session_id,
                input_tokens,
                output_tokens,
            });
        }
    }
    Ok(batch)
}

struct RolloutState {
    model_id: String,
    thinking_effort: String,
    total: Option<(u64, u64)>,
}

impl RolloutState {
    fn new(source: &SessionSource) -> Self {
        Self {
            model_id: source.model_id.clone(),
            thinking_effort: source.thinking_effort.clone(),
            total: None,
        }
    }
}

fn scan_rollout(
    path: &Path,
    source: &SessionSource,
    window: &ImportWindow,
    state: &mut RolloutState,
    events: &mut Vec<HistoryEvent>,
) -> anyhow::Result<()> {
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let rollout_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("rollout");
    let mut first_snapshot = true;
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            update_turn_context(payload, &mut state.model_id, &mut state.thinking_effort);
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
        let previous = state.total.unwrap_or_default();
        let delta = (
            rollout_delta(current.0, previous.0, first_snapshot),
            rollout_delta(current.1, previous.1, first_snapshot),
        );
        first_snapshot = false;
        state.total = Some(current);
        if !window.contains(timestamp) || delta == (0, 0) {
            continue;
        }
        events.push(HistoryEvent {
            session_id: source.session_id,
            event_id: format!(
                "history:codex:{rollout_id}:{line_index}:{}",
                timestamp.to_rfc3339()
            ),
            day: timestamp.date_naive().to_string(),
            model_id: state.model_id.clone(),
            thinking_effort: state.thinking_effort.clone(),
            input_tokens: delta.0,
            output_tokens: delta.1,
        });
    }
    Ok(())
}

fn rollout_delta(current: u64, previous: u64, first_snapshot: bool) -> u64 {
    if first_snapshot && current < previous {
        current
    } else {
        current.saturating_sub(previous)
    }
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
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path(), directory.join("cycle")).unwrap();
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

    #[test]
    fn combines_multiple_rollouts_and_counts_a_new_file_counter_reset() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("2026").join("07").join("20");
        std::fs::create_dir_all(&directory).unwrap();
        let session_id = "019f2948-8e1b-7892-8409-0529e5d5e268";
        let first = directory.join(format!("rollout-2026-07-20T00-00-00-{session_id}.jsonl"));
        let second = directory.join(format!("rollout-2026-07-20T01-00-00-{session_id}.jsonl"));
        std::fs::write(
            first,
            "{\"timestamp\":\"2026-07-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":10}}}}\n",
        )
        .unwrap();
        std::fs::write(
            second,
            concat!(
                "{\"timestamp\":\"2026-07-20T01:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":20,\"output_tokens\":2}}}}\n",
                "{\"timestamp\":\"2026-07-20T01:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":30,\"output_tokens\":3}}}}\n"
            ),
        )
        .unwrap();
        let source = SessionSource {
            session_id: 9,
            runtime_session_id: session_id.into(),
            model_id: "gpt-5.6".into(),
            thinking_effort: "high".into(),
        };
        let window = ImportWindow {
            cutoff_at: Utc.with_ymd_and_hms(2026, 7, 28, 0, 0, 0).unwrap(),
            start_day: chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap(),
        };

        let batch = scan(root.path(), &[source], &window).unwrap();

        assert_eq!(batch.events.len(), 3);
        assert_eq!(
            batch
                .events
                .iter()
                .map(|event| (event.input_tokens, event.output_tokens))
                .collect::<Vec<_>>(),
            vec![(100, 10), (20, 2), (10, 1)]
        );
        assert_eq!(
            batch.checkpoints,
            vec![SessionCheckpoint {
                session_id: 9,
                input_tokens: 30,
                output_tokens: 3
            }]
        );
    }
}
