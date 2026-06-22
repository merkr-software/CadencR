use std::path::Path;

use sqlx::{AssertSqlSafe, SqlitePool};

use crate::domain::settings_store::{self, paths, store, Scope};

/// Workspace setting key holding the last-used thinking effort for a given
/// provider/model pair. Mirrors the frontend helper in
/// `packages/desktop/src/shared/thinking-effort.ts`.
pub fn thinking_effort_model_key(provider_id: &str, model_id: &str) -> String {
    format!("thinking_effort_model_{provider_id}_{model_id}")
}

/// Feature-level real columns still resolved from SQLite (feature settings did
/// not migrate to JSON — they hold runtime/worktree state).
const SHARED_COLUMNS: &[&str] = &["model_session", "agent_runtime_session"];

async fn resolve_table_kv_setting(
    pool: &SqlitePool,
    table: &str,
    row_id: i64,
    key: &str,
) -> Option<String> {
    let (scope_id, kv_table) = match table {
        "features" => ("feature_id", "feature_settings"),
        "projects" => ("project_id", "project_settings"),
        _ => return None,
    };

    let sql = format!("SELECT value FROM {kv_table} WHERE {scope_id} = ? AND key = ? LIMIT 1");
    sqlx::query_scalar::<_, Option<String>>(AssertSqlSafe(sql))
        .bind(row_id)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .flatten()
        .filter(|value| !value.is_empty())
}

async fn table_has_column(pool: &SqlitePool, table: &str, key: &str) -> bool {
    let sql = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ? LIMIT 1");
    sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql))
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

pub(crate) async fn resolve_table_column_setting(
    pool: &SqlitePool,
    table: &str,
    row_id: i64,
    key: &str,
) -> Option<String> {
    if !table_has_column(pool, table, key).await {
        return None;
    }

    let sql = format!(r#"SELECT "{key}" as v FROM {table} WHERE id = ?"#);
    if let Ok(Some((Some(v),))) = sqlx::query_as::<_, (Option<String>,)>(AssertSqlSafe(sql))
        .bind(row_id)
        .fetch_optional(pool)
        .await
    {
        if !v.is_empty() {
            return Some(v);
        }
    }

    None
}

/// Resolve a setting using the cascade: feature (SQLite) → project (JSON) →
/// global (JSON) → default. Only empty strings are treated as unset and fall
/// through. Global and project settings live in JSON files now; feature
/// settings remain SQLite-backed.
pub async fn resolve_setting(
    pool: &SqlitePool,
    key: &str,
    feature_id: Option<i64>,
    project_id: Option<i64>,
    default_value: Option<&str>,
) -> Option<String> {
    resolve_in(
        &settings_store::global_dir(),
        pool,
        key,
        feature_id,
        project_id,
        default_value,
    )
    .await
}

/// Cascade core parameterized on the settings directory so it is unit-testable
/// against a temp dir.
pub(crate) async fn resolve_in(
    dir: &Path,
    pool: &SqlitePool,
    key: &str,
    feature_id: Option<i64>,
    project_id: Option<i64>,
    default_value: Option<&str>,
) -> Option<String> {
    // 1. Feature-level (SQLite: real column then EAV).
    if let Some(fid) = feature_id {
        if SHARED_COLUMNS.contains(&key) {
            if let Some(v) = resolve_table_column_setting(pool, "features", fid, key).await {
                return Some(v);
            }
        }
        if let Some(v) = resolve_table_kv_setting(pool, "features", fid, key).await {
            return Some(v);
        }
    }

    // 2. Project-level (JSON file).
    if let Some(pid) = project_id {
        if let Ok(path) = paths::project_file(dir, pool, pid).await {
            let (map, _warnings) = store::load(&path, Scope::Project);
            if let Some(v) = map.get(key) {
                if !v.is_empty() {
                    return Some(v.clone());
                }
            }
        }
    }

    // 3. Global (JSON file).
    let (global, _warnings) = store::load(&paths::global_file(dir), Scope::Workspace);
    if let Some(v) = global.get(key) {
        if !v.is_empty() {
            return Some(v.clone());
        }
    }

    default_value.map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Pool with a feature-level SQLite surface (features + feature_settings)
    /// and a projects table for project-file name resolution. Project and
    /// global settings now live in JSON, so those tables are gone.
    async fn feature_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE features (
                id INTEGER PRIMARY KEY,
                project_id INTEGER,
                title TEXT,
                model_session TEXT,
                agent_runtime_session TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '/tmp')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE feature_settings (feature_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(feature_id, key))")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn insert_project(pool: &SqlitePool, id: i64, name: &str) {
        sqlx::query("INSERT INTO projects (id, name) VALUES (?, ?)")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_feature(
        pool: &SqlitePool,
        id: i64,
        project_id: i64,
        model_session: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO features (id, project_id, title, model_session) VALUES (?, ?, 'f', ?)",
        )
        .bind(id)
        .bind(project_id)
        .bind(model_session)
        .execute(pool)
        .await
        .unwrap();
    }

    fn write_json(path: &std::path::Path, pairs: &[(&str, &str)]) {
        let map: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        settings_store::file::write_atomic(path, &settings_store::file::serialize_map(&map))
            .unwrap();
    }

    async fn project_file(dir: &std::path::Path, pool: &SqlitePool, id: i64) -> std::path::PathBuf {
        paths::project_file(dir, pool, id).await.unwrap()
    }

    #[tokio::test]
    async fn feature_level_wins() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        insert_feature(&pool, 1, 1, Some("feature-model")).await;
        write_json(
            &project_file(dir.path(), &pool, 1).await,
            &[("model_session", "project-model")],
        );

        let result = resolve_in(
            dir.path(),
            &pool,
            "model_session",
            Some(1),
            Some(1),
            Some("default-model"),
        )
        .await;
        assert_eq!(result, Some("feature-model".to_string()));
    }

    #[tokio::test]
    async fn project_level_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        insert_feature(&pool, 1, 1, None).await;
        write_json(
            &project_file(dir.path(), &pool, 1).await,
            &[("model_session", "project-model")],
        );

        let result = resolve_in(
            dir.path(),
            &pool,
            "model_session",
            Some(1),
            Some(1),
            Some("default-model"),
        )
        .await;
        assert_eq!(result, Some("project-model".to_string()));
    }

    #[tokio::test]
    async fn global_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        insert_feature(&pool, 1, 1, None).await;
        write_json(
            &paths::global_file(dir.path()),
            &[("model_session", "global-model")],
        );

        let result = resolve_in(
            dir.path(),
            &pool,
            "model_session",
            Some(1),
            Some(1),
            Some("default-model"),
        )
        .await;
        assert_eq!(result, Some("global-model".to_string()));
    }

    #[tokio::test]
    async fn default_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        insert_feature(&pool, 1, 1, None).await;

        let result = resolve_in(
            dir.path(),
            &pool,
            "model_session",
            Some(1),
            Some(1),
            Some("default-model"),
        )
        .await;
        assert_eq!(result, Some("default-model".to_string()));
    }

    #[tokio::test]
    async fn feature_kv_beats_project_json() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        insert_feature(&pool, 1, 1, None).await;
        sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'custom_kv_key', 'high')")
            .execute(&pool).await.unwrap();
        write_json(
            &project_file(dir.path(), &pool, 1).await,
            &[("custom_kv_key", "medium")],
        );

        let result = resolve_in(dir.path(), &pool, "custom_kv_key", Some(1), Some(1), None).await;
        assert_eq!(result, Some("high".to_string()));
    }

    #[tokio::test]
    async fn default_value_is_not_special() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        insert_feature(&pool, 1, 1, Some("default")).await;

        // "default" is a regular value, not a magic keyword — feature wins.
        let result = resolve_in(
            dir.path(),
            &pool,
            "model_session",
            Some(1),
            Some(1),
            Some("default-model"),
        )
        .await;
        assert_eq!(result, Some("default".to_string()));
    }

    #[tokio::test]
    async fn project_only_key_from_json() {
        let dir = tempfile::tempdir().unwrap();
        let pool = feature_pool().await;
        insert_project(&pool, 1, "p").await;
        write_json(
            &project_file(dir.path(), &pool, 1).await,
            &[("branch_prefix", "feature/")],
        );

        let result = resolve_in(dir.path(), &pool, "branch_prefix", None, Some(1), None).await;
        assert_eq!(result, Some("feature/".to_string()));
    }

    #[tokio::test]
    async fn missing_shared_column_falls_back_to_default() {
        // features table without the model/runtime columns — the column probe
        // must not error, and the cascade falls through to the default.
        let dir = tempfile::tempdir().unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '/tmp')")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE feature_settings (feature_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(feature_id, key))")
            .execute(&pool).await.unwrap();
        insert_project(&pool, 1, "p").await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f')")
            .execute(&pool)
            .await
            .unwrap();

        let result = resolve_in(
            dir.path(),
            &pool,
            "agent_runtime_session",
            Some(1),
            Some(1),
            Some("claude_code"),
        )
        .await;
        assert_eq!(result, Some("claude_code".to_string()));
    }
}
