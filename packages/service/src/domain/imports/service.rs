//! Orchestration layer: list importable conversations and persist them as
//! `features` + `agent_sessions` + `agent_messages`. Pure DB work goes
//! through sqlx; provider parsing is delegated to provider modules.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::domain::agents::claude_code::config_dir as claude_config_dir;
use crate::error::AppError;

use super::claude_code_jsonl::{list_session_files, parse_session_file, ImportedConversation};
use super::codex_rollout;
use super::models::{ImportConversationSummary, ImportProvider, SkipReason, SkippedRecord};
use super::opencode_sqlite;
use super::persistence::persist_imported_conversation;
pub use super::persistence::ImportOutcome;

/// Look up a project's filesystem `path`. The caller uses it to derive the
/// provider's on-disk conversation directory.
pub async fn project_path(pool: &SqlitePool, project_id: i64) -> Result<String, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT path FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await?;
    row.map(|r| r.0)
        .ok_or_else(|| AppError::NotFound(format!("project {project_id} not found")))
}

/// Source session UUIDs already imported into a project for a given provider.
/// The provenance lives on `agent_sessions.(runtime_provider, runtime_session_id)` —
/// we don't shadow it onto `features`, so this is a join, not a column read.
pub async fn already_imported_ids(
    pool: &SqlitePool,
    project_id: i64,
    provider: ImportProvider,
) -> Result<HashSet<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT s.runtime_session_id
         FROM features f
         JOIN agent_sessions s ON s.feature_id = f.id
         WHERE f.project_id = ?
           AND s.runtime_provider = ?
           AND s.runtime_session_id IS NOT NULL",
    )
    .bind(project_id)
    .bind(provider.as_str())
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(s,)| s).collect())
}

pub async fn list_provider_conversations(
    pool: &SqlitePool,
    project_id: i64,
    provider: ImportProvider,
) -> Result<Vec<ImportConversationSummary>, AppError> {
    let (project_path_str, imported) = tokio::try_join!(
        project_path(pool, project_id),
        already_imported_ids(pool, project_id, provider)
    )?;
    let parsed = list_provider_conversations_from_source(provider, &project_path_str).await?;
    let mut out: Vec<ImportConversationSummary> = parsed
        .into_iter()
        .map(|conv| ImportConversationSummary {
            already_imported: imported.contains(&conv.source_session_id),
            source_session_id: conv.source_session_id,
            title: conv.title,
            message_count: conv.messages.len() as u32,
            modified_at: conv.modified_at,
        })
        .collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

pub fn parse_import_provider(provider: &str) -> Result<ImportProvider, AppError> {
    ImportProvider::from_id(provider)
        .ok_or_else(|| AppError::BadRequest(format!("Unsupported import provider '{provider}'")))
}

async fn list_provider_conversations_from_source(
    provider: ImportProvider,
    project_path_str: &str,
) -> Result<Vec<ImportedConversation>, AppError> {
    match provider {
        ImportProvider::ClaudeCode => {
            // Conversations to import become sessions of the active profile.
            let config_dir = claude_config_dir::for_profile(None)?;
            let project_path = project_path_str.to_string();
            tokio::task::spawn_blocking(move || scan_claude_code_dir(&config_dir, &project_path))
                .await
                .map_err(|e| AppError::internal(format!("scan task panicked: {e}")))?
        }
        ImportProvider::CodexCli => {
            let project_path = project_path_str.to_string();
            tokio::task::spawn_blocking(move || {
                codex_rollout::list_project_conversations(&project_path)
            })
            .await
            .map_err(|e| AppError::internal(format!("scan task panicked: {e}")))?
            .map_err(|e| AppError::internal(format!("scan Codex rollouts: {e}")))
        }
        ImportProvider::Opencode => {
            opencode_sqlite::list_project_conversations(project_path_str).await
        }
    }
}

fn scan_claude_code_dir(
    config_dir: &Path,
    project_path: &str,
) -> Result<Vec<ImportedConversation>, AppError> {
    let dir = claude_config_dir::transcripts_dir(config_dir, Path::new(project_path));
    let files = list_session_files(&dir)
        .map_err(|e| AppError::internal(format!("read {}: {e}", dir.display())))?;
    let mut out = Vec::with_capacity(files.len());
    for path in files {
        match parse_session_file(&path) {
            Ok(Some(c)) => out.push(c),
            Ok(None) => {}
            Err(err) => tracing::warn!(
                file = %path.display(),
                error = %err,
                "failed to parse Claude Code JSONL — skipping"
            ),
        }
    }
    Ok(out)
}

pub(crate) enum LoadedSession {
    Found(ImportedConversation),
    NotFound,
    Empty,
}

/// Load a single provider conversation from disk by `(project_path, session_id)`
/// without persisting it. Shared by the importer (which turns it into a new
/// feature) and the session-refresh path (which appends newer events to an
/// existing session). Parse / IO errors bubble as `AppError` so callers can
/// decide whether to skip the record or surface the failure to the user.
/// `profile` is the provider profile the session runs under (none: the active
/// one): a Claude profile may keep its transcripts in its own config dir.
pub(crate) async fn load_provider_session(
    provider: ImportProvider,
    project_path: &str,
    source_session_id: &str,
    profile: Option<&str>,
) -> Result<LoadedSession, AppError> {
    let source = match provider {
        ImportProvider::Opencode => {
            let loaded =
                opencode_sqlite::load_project_conversation_by_id(project_path, source_session_id)
                    .await?;
            return Ok(loaded.map_or(LoadedSession::NotFound, LoadedSession::Found));
        }
        ImportProvider::ClaudeCode => {
            ConversationFiles::Claude(claude_config_dir::for_profile(profile)?)
        }
        ImportProvider::CodexCli => ConversationFiles::Codex,
    };
    let project_path = project_path.to_string();
    let session_id = source_session_id.to_string();
    tokio::task::spawn_blocking(move || {
        load_provider_conversation(&source, &project_path, &session_id)
    })
    .await
    .map_err(|e| AppError::internal(format!("load task panicked: {e}")))?
    .map_err(|e| AppError::internal(format!("parse provider session: {e}")))
}

pub async fn import_provider_session_by_id(
    write_pool: &SqlitePool,
    project_id: i64,
    provider: ImportProvider,
    project_path: &str,
    source_session_id: &str,
) -> Result<ImportOutcome, AppError> {
    // An imported conversation becomes a session of the active profile.
    let loaded = match load_provider_session(provider, project_path, source_session_id, None).await
    {
        Ok(loaded) => loaded,
        Err(err) => {
            tracing::warn!(error = %err, provider = provider.as_str(), "failed to load session for import");
            return Ok(ImportOutcome::Skipped(SkippedRecord {
                source_session_id: source_session_id.to_string(),
                reason: SkipReason::ParseError,
            }));
        }
    };
    import_loaded_session(write_pool, project_id, provider, source_session_id, loaded).await
}

async fn import_loaded_session(
    write_pool: &SqlitePool,
    project_id: i64,
    provider: ImportProvider,
    source_session_id: &str,
    loaded: LoadedSession,
) -> Result<ImportOutcome, AppError> {
    let skip = |reason: SkipReason| {
        Ok(ImportOutcome::Skipped(SkippedRecord {
            source_session_id: source_session_id.to_string(),
            reason,
        }))
    };
    match loaded {
        LoadedSession::Found(c) => {
            persist_imported_conversation(write_pool, project_id, provider, c).await
        }
        LoadedSession::NotFound => skip(SkipReason::NotFound),
        LoadedSession::Empty => skip(SkipReason::Empty),
    }
}

/// Where a provider keeps the conversation files a blocking load reads.
enum ConversationFiles {
    /// Under this Claude Code config dir.
    Claude(PathBuf),
    Codex,
}

fn load_provider_conversation(
    source: &ConversationFiles,
    project_path: &str,
    source_session_id: &str,
) -> std::io::Result<LoadedSession> {
    match source {
        ConversationFiles::Claude(config_dir) => {
            load_claude_code_conversation(config_dir, project_path, source_session_id)
        }
        ConversationFiles::Codex => Ok(codex_rollout::load_project_conversation_by_id(
            project_path,
            source_session_id,
        )?
        .map_or(LoadedSession::NotFound, LoadedSession::Found)),
    }
}

#[cfg(test)]
pub async fn import_one(
    write_pool: &SqlitePool,
    project_id: i64,
    conv: ImportedConversation,
) -> Result<ImportOutcome, AppError> {
    persist_imported_conversation(write_pool, project_id, ImportProvider::ClaudeCode, conv).await
}

/// Load a single conversation from disk by `(project_path, session_id)`.
/// `NotFound` means no file on disk; `Empty` signals the file existed but had
/// no user/assistant messages. Parse / IO errors bubble so the caller can mark
/// the session `Skipped(ParseError)`.
fn load_claude_code_conversation(
    config_dir: &Path,
    project_path: &str,
    source_session_id: &str,
) -> std::io::Result<LoadedSession> {
    if !is_safe_claude_session_id(source_session_id) {
        return Ok(LoadedSession::NotFound);
    }
    let dir = claude_config_dir::transcripts_dir(config_dir, Path::new(project_path));
    let file_path = dir.join(format!("{source_session_id}.jsonl"));
    if !file_path.exists() {
        return Ok(LoadedSession::NotFound);
    }
    Ok(match parse_session_file(&file_path)? {
        Some(c) => LoadedSession::Found(c),
        None => LoadedSession::Empty,
    })
}

fn is_safe_claude_session_id(source_session_id: &str) -> bool {
    !source_session_id.is_empty()
        && source_session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::imports::claude_code_jsonl::ImportedMessage;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, path TEXT NOT NULL)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', type TEXT NOT NULL DEFAULT 'ws-session', model_session TEXT, agent_runtime_session TEXT)",
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL, agent_type TEXT NOT NULL, runtime_provider TEXT, runtime_session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', started_at TEXT, ended_at TEXT, model TEXT, profile TEXT)",
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', tool_name TEXT, tool_use_id TEXT, parent_tool_use_id TEXT, model TEXT, message_uuid TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn sample_conv(id: &str) -> ImportedConversation {
        ImportedConversation {
            source_session_id: id.to_string(),
            title: "Hello".to_string(),
            model: Some("claude".to_string()),
            started_at: Some("2026-05-26T00:00:00Z".to_string()),
            modified_at: Some("2026-05-27T00:00:00Z".to_string()),
            messages: vec![
                ImportedMessage {
                    role: "user".into(),
                    content: "hi".into(),
                    message_type: "text".into(),
                    tool_name: None,
                    tool_use_id: None,
                    model: None,
                    created_at: None,
                },
                ImportedMessage {
                    role: "assistant".into(),
                    content: "hello".into(),
                    message_type: "text".into(),
                    tool_name: None,
                    tool_use_id: None,
                    model: Some("claude".into()),
                    created_at: None,
                },
            ],
        }
    }

    #[tokio::test]
    async fn import_one_creates_feature_session_and_messages() {
        let pool = setup_pool().await;
        let out = import_one(&pool, 1, sample_conv("s1")).await.unwrap();
        match out {
            ImportOutcome::Imported(r) => assert_eq!(r.source_session_id, "s1"),
            ImportOutcome::Skipped(_) => panic!("expected import"),
        }
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        let (started, ended): (String, String) =
            sqlx::query_as("SELECT started_at, ended_at FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(started, "2026-05-26T00:00:00Z");
        assert_eq!(ended, "2026-05-27T00:00:00Z");
    }

    #[tokio::test]
    async fn import_one_skips_duplicate_session() {
        let pool = setup_pool().await;
        import_one(&pool, 1, sample_conv("s1")).await.unwrap();
        let out = import_one(&pool, 1, sample_conv("s1")).await.unwrap();
        match out {
            ImportOutcome::Skipped(s) => {
                assert!(matches!(s.reason, SkipReason::AlreadyImported));
            }
            ImportOutcome::Imported(_) => panic!("expected skip"),
        }
    }

    #[tokio::test]
    async fn already_imported_ids_returns_inserted_session() {
        let pool = setup_pool().await;
        import_one(&pool, 1, sample_conv("s1")).await.unwrap();
        let ids = already_imported_ids(&pool, 1, ImportProvider::ClaudeCode)
            .await
            .unwrap();
        assert!(ids.contains("s1"));
    }

    #[test]
    fn claude_session_ids_must_stay_file_stems() {
        assert!(is_safe_claude_session_id(
            "00000000-0000-4000-8000-000000000000"
        ));
        for unsafe_id in ["../outside", "nested/session", ""] {
            assert!(!is_safe_claude_session_id(unsafe_id));
        }
    }

    /// The CLI sync re-reads a session's transcript where its profile keeps it.
    #[tokio::test]
    async fn a_claude_transcript_loads_from_the_profile_config_dir() {
        use crate::shared::test_env::{async_env_lock, EnvVarGuard};
        let _env = async_env_lock().lock().await;
        let home = tempfile::tempdir().unwrap();
        let _home = EnvVarGuard::set("HOME", home.path().to_str().unwrap());
        let _unset = EnvVarGuard::remove("CLAUDE_CONFIG_DIR");
        let config = tempfile::tempdir().unwrap();
        let env = std::collections::HashMap::from([(
            "CLAUDE_CONFIG_DIR".to_string(),
            config.path().to_str().unwrap().to_string(),
        )]);
        crate::domain::agents::claude_code::profiles::upsert_profile("work", &env)
            .await
            .unwrap();
        let project = "/Users/test/profiled";
        let dir = claude_config_dir::transcripts_dir(config.path(), Path::new(project));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("sid.jsonl"),
            r#"{"type":"user","uuid":"u1","sessionId":"sid","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}"#,
        )
        .unwrap();

        let loaded =
            load_provider_session(ImportProvider::ClaudeCode, project, "sid", Some("work"))
                .await
                .unwrap();

        assert!(matches!(loaded, LoadedSession::Found(_)));
    }
}
