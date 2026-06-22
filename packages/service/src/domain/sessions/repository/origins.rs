//! Message provenance hydration for `agent_message_origins`.

use std::collections::HashMap;

use sqlx::{AssertSqlSafe, FromRow, SqlitePool};

use super::super::models::{AgentMessageOrigin, AgentMessageRow};
use crate::error::AppError;

#[derive(FromRow)]
struct OriginRow {
    message_id: i64,
    origin_kind: String,
    source_session_id: Option<i64>,
    source_feature_id: Option<i64>,
    source_project_id: Option<i64>,
    source_message_id: Option<i64>,
    note: Option<String>,
    created_at: Option<String>,
}

pub(super) async fn attach_message_origins(
    pool: &SqlitePool,
    messages_by_session: &mut HashMap<i64, Vec<AgentMessageRow>>,
) -> Result<(), AppError> {
    let message_ids = message_ids(messages_by_session);
    if message_ids.is_empty() || !origin_table_exists(pool).await? {
        return Ok(());
    }
    let origins = fetch_origins(pool, &message_ids).await?;
    if origins.is_empty() {
        return Ok(());
    }
    for messages in messages_by_session.values_mut() {
        for message in messages {
            message.origin = origins.get(&message.id).cloned();
        }
    }
    Ok(())
}

fn message_ids(messages_by_session: &HashMap<i64, Vec<AgentMessageRow>>) -> Vec<i64> {
    let mut ids: Vec<i64> = messages_by_session
        .values()
        .flat_map(|messages| messages.iter().map(|message| message.id))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

async fn origin_table_exists(pool: &SqlitePool) -> Result<bool, AppError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'agent_message_origins'",
    )
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

async fn fetch_origins(
    pool: &SqlitePool,
    message_ids: &[i64],
) -> Result<HashMap<i64, AgentMessageOrigin>, AppError> {
    let placeholders = message_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT message_id, origin_kind, source_session_id, source_feature_id,
                source_project_id, source_message_id, note, created_at
         FROM agent_message_origins WHERE message_id IN ({placeholders})"
    );
    let mut query = sqlx::query_as::<_, OriginRow>(AssertSqlSafe(sql));
    for id in message_ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.message_id, row.into()))
        .collect())
}

impl From<OriginRow> for AgentMessageOrigin {
    fn from(row: OriginRow) -> Self {
        Self {
            origin_kind: row.origin_kind,
            source_session_id: row.source_session_id,
            source_feature_id: row.source_feature_id,
            source_project_id: row.source_project_id,
            source_message_id: row.source_message_id,
            note: row.note,
            created_at: row.created_at,
        }
    }
}
