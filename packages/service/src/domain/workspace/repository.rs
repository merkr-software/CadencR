use super::models::{AgentProviderSettings, ModelSettings, Setting};
use crate::error::AppError;
use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::domain::agents::providers::provider_default_model;
use crate::domain::agents::runtime::{
    default_provider_settings, model_setting_key, runtime_setting_key, validate_agent_type,
};

const MODEL_KEYS: &[(&str, &str)] = &[
    ("session", "model_session"),
    ("auto_name", "model_auto_name"),
];

fn provider_keys() -> [(&'static str, String); 2] {
    [
        ("session", runtime_setting_key("session")),
        ("auto_name", runtime_setting_key("auto_name")),
    ]
}

// Global settings now live in `~/.cadencr/settings/settings.json` rather than
// the SQLite `settings` table. These functions delegate to `settings_store`;
// the `_pool` parameter is retained so the many call sites (routes, the
// resolution cascade, binary-override startup) stay unchanged. The legacy
// `settings` table is left intact as a backup but is no longer read or written.

/// A settings file that cannot be read is an error, not "unset": the caller
/// would otherwise act on a default the user may have changed (re-opening
/// onboarding, for one). The interface language initializes its upgrade state on first read.
pub async fn get_setting(_pool: &SqlitePool, key: &str) -> Result<Option<String>, AppError> {
    use crate::domain::settings_store;
    if key == "ui_language" {
        return settings_store::interface_language_preference().await;
    }
    settings_store::global_read(key)
}

/// A switch that is on when absent. Read failures must reach the caller.
pub fn setting_enabled_by_default(key: &str) -> Result<bool, AppError> {
    crate::domain::settings_store::global_inspect_document(|doc| enabled_by_default_in(doc, key))
}

pub(crate) fn enabled_by_default_in(
    doc: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<bool, AppError> {
    use crate::domain::settings_store::{file, Scope};
    Ok(file::read_scalar(doc, Scope::Workspace, key)?.as_deref() != Some("false"))
}

/// Like `get_setting` but treats empty/whitespace-only values as unset.
pub async fn get_nonempty_setting(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<String>, AppError> {
    Ok(get_setting(pool, key)
        .await?
        .filter(|value| !value.trim().is_empty()))
}

pub async fn set_setting(_pool: &SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    crate::domain::settings_store::global_set(key, value).await
}

pub async fn list_settings(_pool: &SqlitePool) -> Result<Vec<Setting>, AppError> {
    crate::domain::settings_store::global_list()
}

pub async fn get_model_settings(pool: &SqlitePool) -> Result<ModelSettings, AppError> {
    let provider_settings = get_provider_settings(pool).await?;
    let provider_by_agent = [
        ("session", provider_settings.session.as_str()),
        ("auto_name", provider_settings.auto_name.as_str()),
    ];
    let mut defaults_by_provider = HashMap::new();
    let mut models_by_agent = HashMap::new();

    for ((agent_type, provider_id), (_, db_key)) in provider_by_agent.into_iter().zip(MODEL_KEYS) {
        if let Some(model) = get_setting(pool, db_key).await? {
            models_by_agent.insert(agent_type, model);
            continue;
        }
        if !defaults_by_provider.contains_key(provider_id) {
            let default = provider_default_model(pool, provider_id).await?;
            defaults_by_provider.insert(provider_id, default);
        }
        if let Some(model) = defaults_by_provider[provider_id].as_ref() {
            models_by_agent.insert(agent_type, model.clone());
        }
    }

    Ok(ModelSettings {
        session: models_by_agent.remove("session").unwrap_or_default(),
        auto_name: models_by_agent.remove("auto_name").unwrap_or_default(),
    })
}

pub async fn set_model_setting(
    pool: &SqlitePool,
    agent_type: &str,
    model_id: &str,
) -> Result<(), AppError> {
    if !validate_agent_type(agent_type) {
        return Err(AppError::BadRequest(format!(
            "Invalid model type: {}",
            agent_type
        )));
    }
    set_setting(pool, &model_setting_key(agent_type), model_id).await
}

pub async fn get_provider_settings(pool: &SqlitePool) -> Result<AgentProviderSettings, AppError> {
    let mut settings = default_provider_settings();

    for (agent_type, db_key) in provider_keys() {
        let provider = get_setting(pool, &db_key).await?.unwrap_or_default();
        match agent_type {
            "session" => settings.session = provider,
            "auto_name" => settings.auto_name = provider,
            _ => {}
        }
    }

    Ok(settings)
}

pub async fn set_provider_setting(
    pool: &SqlitePool,
    agent_type: &str,
    provider_id: &str,
) -> Result<(), AppError> {
    if !validate_agent_type(agent_type) {
        return Err(AppError::BadRequest(format!(
            "Invalid provider type: {}",
            agent_type
        )));
    }

    let db_key = runtime_setting_key(agent_type);
    set_setting(pool, &db_key, provider_id).await
}

pub async fn get_prompt_history(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT content FROM prompt_history WHERE project_id = ? ORDER BY created_at DESC LIMIT 100",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

pub async fn add_prompt_entry(
    pool: &SqlitePool,
    project_id: i64,
    content: &str,
) -> Result<bool, AppError> {
    // Dedup: skip if the most recent entry has the same content
    let latest: Option<(String,)> = sqlx::query_as(
        "SELECT content FROM prompt_history WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;

    if let Some((latest_content,)) = latest {
        if latest_content == content {
            return Ok(false); // skipped
        }
    }

    sqlx::query("INSERT INTO prompt_history (project_id, content) VALUES (?, ?)")
        .bind(project_id)
        .bind(content)
        .execute(pool)
        .await?;

    // Trim to 100 entries
    sqlx::query(
        "DELETE FROM prompt_history WHERE project_id = ? AND id NOT IN \
         (SELECT id FROM prompt_history WHERE project_id = ? ORDER BY created_at DESC LIMIT 100)",
    )
    .bind(project_id)
    .bind(project_id)
    .execute(pool)
    .await?;

    Ok(true) // inserted
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE prompt_history (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                project_id INTEGER NOT NULL, \
                content TEXT NOT NULL, \
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    // Global settings get/set/list moved to JSON files; their behavior is
    // covered by `settings_store`'s own tests. The prompt-history helpers below
    // remain SQLite-backed.

    #[tokio::test]
    async fn test_add_prompt_entry_basic() {
        let pool = setup_test_db().await;

        let inserted = add_prompt_entry(&pool, 1, "hello world").await.unwrap();
        assert!(inserted);

        let history = get_prompt_history(&pool, 1).await.unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0], "hello world");
    }

    #[tokio::test]
    async fn test_add_prompt_entry_deduplication() {
        let pool = setup_test_db().await;

        let first = add_prompt_entry(&pool, 1, "duplicate prompt")
            .await
            .unwrap();
        assert!(first);

        let second = add_prompt_entry(&pool, 1, "duplicate prompt")
            .await
            .unwrap();
        assert!(!second); // skipped
    }

    #[tokio::test]
    async fn language_read_retries_initialization_after_the_settings_file_is_repaired() {
        use crate::domain::settings_store::{file, global_dir, paths};
        let pool = setup_test_db().await;
        let path = paths::global_file(&global_dir());
        file::write_atomic(&path, "invalid json").unwrap();
        assert!(get_setting(&pool, "ui_language").await.is_err());
        file::write_atomic(&path, r#"{"onboarding_step":"completed"}"#).unwrap();
        assert_eq!(
            get_setting(&pool, "ui_language").await.unwrap().as_deref(),
            Some("legacy-english")
        );
    }

    #[tokio::test]
    async fn model_settings_surface_the_failure_instead_of_inventing_a_model() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        let settings = get_model_settings(&pool)
            .await
            .expect("get_model_settings should not fail against an empty pool");

        // "opus" must never be fabricated as a fallback.
        assert_ne!(settings.session, "opus", "hardcoded placeholder leaked");
    }

    /// An unreadable settings file used to read as "unset", which re-opened
    /// onboarding over a workspace that had finished it. A missing file is
    /// still a workspace with no overrides.
    #[tokio::test]
    async fn an_unreadable_settings_file_is_an_error_not_unset() {
        use axum::response::IntoResponse;
        let pool = setup_test_db().await;
        assert_eq!(get_setting(&pool, "onboarding_step").await.unwrap(), None);

        let path = crate::domain::settings_store::paths::global_file(
            &crate::domain::settings_store::global_dir(),
        );
        std::fs::create_dir_all(&path).unwrap();

        let error = get_setting(&pool, "onboarding_step").await.unwrap_err();
        assert!(
            error.to_string().contains(&path.display().to_string()),
            "{error}"
        );
        assert!(list_settings(&pool).await.is_err());
        assert_eq!(
            error.into_response().status(),
            axum::http::StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
