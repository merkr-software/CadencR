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

const ORIGIN_CHUNK_SIZE: usize = 500;

pub(super) async fn attach_message_origins(
    pool: &SqlitePool,
    messages_by_session: &mut HashMap<i64, Vec<AgentMessageRow>>,
) -> Result<(), AppError> {
    let message_ids = message_ids(messages_by_session);
    if message_ids.is_empty() {
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

pub(crate) async fn get_message_origin(
    pool: &SqlitePool,
    message_id: i64,
) -> Result<Option<AgentMessageOrigin>, AppError> {
    let row = sqlx::query_as::<_, OriginRow>(
        "SELECT message_id, origin_kind, source_session_id, source_feature_id,
                source_project_id, source_message_id, note, created_at
         FROM agent_message_origins WHERE message_id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(AgentMessageOrigin::from))
}

pub(crate) fn origin_matches_session_generated(
    origin: &AgentMessageOrigin,
    source_session_id: i64,
    source_feature_id: i64,
    source_project_id: i64,
    note: Option<&str>,
) -> bool {
    origin.origin_kind == "session_generated"
        && origin.source_session_id == Some(source_session_id)
        && origin.source_feature_id == Some(source_feature_id)
        && origin.source_project_id == Some(source_project_id)
        && origin.source_message_id.is_none()
        && origin.note.as_deref() == note
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

async fn fetch_origins(
    pool: &SqlitePool,
    message_ids: &[i64],
) -> Result<HashMap<i64, AgentMessageOrigin>, sqlx::Error> {
    let mut origins = HashMap::new();
    for chunk in message_ids.chunks(ORIGIN_CHUNK_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT message_id, origin_kind, source_session_id, source_feature_id,
                    source_project_id, source_message_id, note, created_at
             FROM agent_message_origins WHERE message_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, OriginRow>(AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(id);
        }
        for row in query.fetch_all(pool).await? {
            origins.insert(row.message_id, row.into());
        }
    }
    Ok(origins)
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
