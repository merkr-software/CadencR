use sqlx::SqlitePool;

use crate::error::AppError;

use super::models::{ImportProvider, ImportedRecord, SkipReason, SkippedRecord};
use super::types::ImportedConversation;

/// Outcome of importing a single conversation.
pub enum ImportOutcome {
    Imported(ImportedRecord),
    Skipped(SkippedRecord),
}

/// Persist a parsed conversation for a specific runtime provider.
pub async fn persist_imported_conversation(
    write_pool: &SqlitePool,
    project_id: i64,
    provider: ImportProvider,
    conv: ImportedConversation,
) -> Result<ImportOutcome, AppError> {
    let mut tx = write_pool.begin().await?;

    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT s.id
         FROM features f
         JOIN agent_sessions s ON s.feature_id = f.id
         WHERE f.project_id = ?
           AND s.runtime_provider = ?
           AND s.runtime_session_id = ?
         LIMIT 1",
    )
    .bind(project_id)
    .bind(provider.as_str())
    .bind(&conv.source_session_id)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_some() {
        return Ok(ImportOutcome::Skipped(SkippedRecord {
            source_session_id: conv.source_session_id,
            reason: SkipReason::AlreadyImported,
        }));
    }

    let feature_result = sqlx::query(
        "INSERT INTO features (project_id, title, status, type, model_session, agent_runtime_session) VALUES (?, ?, 'active', 'ws-session', ?, ?)",
    )
    .bind(project_id)
    .bind(&conv.title)
    .bind(conv.model.as_deref())
    .bind(provider.as_str())
    .execute(&mut *tx)
    .await?;
    let feature_id = feature_result.last_insert_rowid();

    let session_result = sqlx::query(
        "INSERT INTO agent_sessions (feature_id, agent_type, runtime_provider, runtime_session_id, status, started_at, ended_at, model) VALUES (?, 'session', ?, ?, 'completed', ?, ?, ?)",
    )
    .bind(feature_id)
    .bind(provider.as_str())
    .bind(&conv.source_session_id)
    .bind(conv.started_at.as_deref().or(conv.modified_at.as_deref()))
    .bind(conv.modified_at.as_deref())
    .bind(conv.model.as_deref())
    .execute(&mut *tx)
    .await?;
    let session_id = session_result.last_insert_rowid();

    for msg in conv.messages.iter() {
        insert_message(&mut tx, session_id, msg, &conv).await?;
    }

    tx.commit().await?;
    Ok(ImportOutcome::Imported(ImportedRecord {
        source_session_id: conv.source_session_id,
        feature_id,
    }))
}

/// Insert one neutralized message into `agent_messages` for `session_id`,
/// applying the same role/type and model-fallback mapping the importer uses.
/// Shared by full-conversation import and the session-refresh append path so
/// both produce identical rows. Accepts a connection so callers can run it
/// inside their own transaction.
pub(crate) async fn insert_message(
    conn: &mut sqlx::SqliteConnection,
    session_id: i64,
    msg: &super::types::ImportedMessage,
    conv: &ImportedConversation,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO agent_messages (session_id, role, content, message_type, tool_name, tool_use_id, parent_tool_use_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))",
    )
    .bind(session_id)
    .bind(&msg.role)
    .bind(&msg.content)
    .bind(persisted_message_type(msg))
    .bind(msg.tool_name.as_deref())
    .bind(msg.tool_use_id.as_deref())
    .bind(None::<&str>)
    .bind(msg.model.as_deref().or_else(|| fallback_message_model(msg, conv)))
    .bind(msg.created_at.as_deref())
    .execute(conn)
    .await?;
    Ok(())
}

fn persisted_message_type(msg: &super::types::ImportedMessage) -> &str {
    if msg.role == "user" && msg.message_type == "text" {
        "user_message"
    } else {
        &msg.message_type
    }
}

fn fallback_message_model<'a>(
    msg: &super::types::ImportedMessage,
    conv: &'a ImportedConversation,
) -> Option<&'a str> {
    if msg.role == "assistant" {
        conv.model.as_deref()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::imports::types::{ImportedConversation, ImportedMessage};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', type TEXT NOT NULL DEFAULT 'ws-session', model_session TEXT, agent_runtime_session TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL, agent_type TEXT NOT NULL, runtime_provider TEXT, runtime_session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', started_at TEXT, ended_at TEXT, model TEXT, profile TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', tool_name TEXT, tool_use_id TEXT, parent_tool_use_id TEXT, model TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn conversation(source_id: &str) -> ImportedConversation {
        ImportedConversation {
            source_session_id: source_id.to_string(),
            title: "Imported".to_string(),
            model: Some("gpt-5.5".to_string()),
            started_at: Some("2026-05-27T12:00:00Z".to_string()),
            modified_at: Some("2026-05-27T12:00:05Z".to_string()),
            messages: vec![ImportedMessage {
                role: "assistant".to_string(),
                content: "done".to_string(),
                message_type: "text".to_string(),
                tool_name: None,
                tool_use_id: None,
                model: Some("model".to_string()),
                created_at: Some("2026-05-27T12:00:05Z".to_string()),
            }],
        }
    }

    #[tokio::test]
    async fn persist_imported_conversation_deduplicates_per_provider() {
        let pool = setup_pool().await;

        let first =
            persist_imported_conversation(&pool, 7, ImportProvider::CodexCli, conversation("same"))
                .await
                .unwrap();
        assert!(matches!(first, super::ImportOutcome::Imported(_)));

        let second =
            persist_imported_conversation(&pool, 7, ImportProvider::Opencode, conversation("same"))
                .await
                .unwrap();
        assert!(matches!(second, super::ImportOutcome::Imported(_)));

        let duplicate =
            persist_imported_conversation(&pool, 7, ImportProvider::CodexCli, conversation("same"))
                .await
                .unwrap();
        assert!(matches!(
            duplicate,
            super::ImportOutcome::Skipped(crate::domain::imports::models::SkippedRecord {
                reason: crate::domain::imports::models::SkipReason::AlreadyImported,
                ..
            })
        ));

        let providers: Vec<String> =
            sqlx::query_scalar("SELECT runtime_provider FROM agent_sessions ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(providers, vec!["codex_cli", "opencode"]);
    }

    #[tokio::test]
    async fn persist_imported_conversation_maps_user_text_to_user_message_blocks() {
        let pool = setup_pool().await;
        let mut conv = conversation("typed");
        conv.messages.insert(
            0,
            ImportedMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
                message_type: "text".to_string(),
                tool_name: None,
                tool_use_id: None,
                model: None,
                created_at: Some("2026-05-27T12:00:01Z".to_string()),
            },
        );

        persist_imported_conversation(&pool, 7, ImportProvider::CodexCli, conv)
            .await
            .unwrap();

        let message_types: Vec<String> =
            sqlx::query_scalar("SELECT message_type FROM agent_messages ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(message_types, vec!["user_message", "text"]);
    }

    #[tokio::test]
    async fn persist_imported_conversation_configures_feature_and_session_provider_model() {
        let pool = setup_pool().await;

        persist_imported_conversation(
            &pool,
            7,
            ImportProvider::CodexCli,
            conversation("configured"),
        )
        .await
        .unwrap();

        let feature: (String, String) = sqlx::query_as(
            "SELECT model_session, agent_runtime_session FROM features WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let session: (String, String) =
            sqlx::query_as("SELECT model, runtime_provider FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        let msg_model: String = sqlx::query_scalar("SELECT model FROM agent_messages WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(feature, ("gpt-5.5".to_string(), "codex_cli".to_string()));
        assert_eq!(session, ("gpt-5.5".to_string(), "codex_cli".to_string()));
        assert_eq!(msg_model, "model");
    }
}
