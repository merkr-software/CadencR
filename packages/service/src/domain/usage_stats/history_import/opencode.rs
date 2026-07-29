use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use super::types::{HistoryEvent, ImportBatch, ImportWindow, SessionSource};

const SESSION_QUERY_CHUNK: usize = 500;

pub async fn scan(
    databases: &[PathBuf],
    sources: &[SessionSource],
    window: &ImportWindow,
) -> anyhow::Result<ImportBatch> {
    if !sources.is_empty() && databases.is_empty() {
        anyhow::bail!("OpenCode history database is unavailable");
    }
    let sources = sources
        .iter()
        .map(|source| (source.runtime_session_id.as_str(), source))
        .collect::<HashMap<_, _>>();
    let mut batch = ImportBatch::default();
    for database in databases {
        scan_database(database, &sources, window, &mut batch).await?;
    }
    Ok(batch)
}

async fn scan_database(
    database: &Path,
    sources: &HashMap<&str, &SessionSource>,
    window: &ImportWindow,
    batch: &mut ImportBatch,
) -> anyhow::Result<()> {
    let pool = open_readonly_pool(database).await?;
    let start_millis = window
        .start_day
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid")
        .and_utc()
        .timestamp_millis();
    let session_ids = sources.keys().copied().collect::<Vec<_>>();
    for session_ids in session_ids.chunks(SESSION_QUERY_CHUNK) {
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT id, session_id, time_created, data
             FROM message
             WHERE time_created >= ",
        );
        query
            .push_bind(start_millis)
            .push(" AND time_created <= ")
            .push_bind(window.cutoff_at.timestamp_millis())
            .push(" AND session_id IN (");
        let mut separated = query.separated(", ");
        for session_id in session_ids {
            separated.push_bind(session_id);
        }
        separated.push_unseparated(") ORDER BY time_created ASC, id ASC");
        let mut rows = query.build().fetch(&pool);
        while let Some(row) = rows
            .try_next()
            .await
            .with_context(|| format!("query {}", database.display()))?
        {
            let session_id: String = row.try_get("session_id")?;
            let Some(source) = sources.get(session_id.as_str()) else {
                continue;
            };
            let message_id: String = row.try_get("id")?;
            let timestamp = row
                .try_get::<i64, _>("time_created")
                .ok()
                .and_then(DateTime::<Utc>::from_timestamp_millis);
            let data = row
                .try_get::<String, _>("data")
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
            let (Some(timestamp), Some(data)) = (timestamp, data) else {
                continue;
            };
            if let Some(event) = history_event(&data, &message_id, source, timestamp) {
                batch.events.push(event);
            }
        }
    }
    Ok(())
}

async fn open_readonly_pool(database: &Path) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(database)
        .read_only(true)
        .foreign_keys(false)
        .busy_timeout(Duration::from_millis(5000))
        .pragma("query_only", "true");
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}

fn history_event(
    data: &Value,
    message_id: &str,
    source: &SessionSource,
    timestamp: DateTime<Utc>,
) -> Option<HistoryEvent> {
    if data.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let tokens = data.get("tokens")?;
    let input_with_cache = token(tokens, "input")
        .saturating_add(
            tokens
                .pointer("/cache/read")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
        .saturating_add(
            tokens
                .pointer("/cache/write")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
    let (input_tokens, output_tokens) = match tokens.get("total").and_then(Value::as_u64) {
        Some(total) if total > 0 => {
            let input_tokens = input_with_cache.min(total);
            (input_tokens, total.saturating_sub(input_tokens))
        }
        _ => (
            input_with_cache,
            token(tokens, "output").saturating_add(token(tokens, "reasoning")),
        ),
    };
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    let model_id = match (
        data.get("providerID").and_then(Value::as_str),
        data.get("modelID").and_then(Value::as_str),
    ) {
        (Some(provider), Some(model)) => format!("{provider}/{model}"),
        _ => source.model_id.clone(),
    };
    Some(HistoryEvent {
        session_id: source.session_id,
        event_id: format!("history:opencode:{message_id}"),
        day: timestamp.date_naive().to_string(),
        model_id,
        thinking_effort: data
            .get("variant")
            .and_then(Value::as_str)
            .unwrap_or(&source.thinking_effort)
            .to_string(),
        input_tokens,
        output_tokens,
    })
}

fn token(tokens: &Value, field: &str) -> u64 {
    tokens.get(field).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[tokio::test]
    async fn reads_database_and_maps_cache_and_reasoning_like_live_accounting() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("opencode.db");
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&database)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            )",
        )
        .execute(&writer)
        .await
        .unwrap();
        let source = SessionSource {
            session_id: 11,
            runtime_session_id: "ses-1".into(),
            model_id: "fallback".into(),
            thinking_effort: String::new(),
        };
        let timestamp = Utc.with_ymd_and_hms(2026, 7, 20, 0, 0, 0).unwrap();
        let data = serde_json::json!({
            "role": "assistant",
            "providerID": "openai",
            "modelID": "gpt-5.6",
            "variant": "high",
            "tokens": {
                "input": 20,
                "output": 10,
                "reasoning": 5,
                "cache": { "read": 3, "write": 2 }
            }
        })
        .to_string();
        sqlx::query(
            "INSERT INTO message (id, session_id, time_created, data)
             VALUES ('msg-1', 'ses-1', ?, ?)",
        )
        .bind(timestamp.timestamp_millis())
        .bind(data)
        .execute(&writer)
        .await
        .unwrap();
        writer.close().await;
        let window = ImportWindow {
            cutoff_at: Utc.with_ymd_and_hms(2026, 7, 28, 0, 0, 0).unwrap(),
            start_day: chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap(),
        };

        let batch = scan(&[database], &[source], &window).await.unwrap();
        assert_eq!(batch.events.len(), 1);
        let event = &batch.events[0];

        assert_eq!(event.input_tokens, 25);
        assert_eq!(event.output_tokens, 15);
        assert_eq!(event.model_id, "openai/gpt-5.6");
        assert_eq!(event.thinking_effort, "high");
        assert_eq!(event.event_id, "history:opencode:msg-1");
    }
}
