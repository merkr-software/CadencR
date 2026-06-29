//! One-time migration of Claude Code profiles out of the legacy SQLite
//! `claude_code_profiles` table and into the nested `profiles` section of the
//! user JSON settings, then dropping the table.
//!
//! Safety properties:
//! - **Copy before drop:** the table is dropped only after the JSON write
//!   succeeds, so a failure leaves the source rows intact for the next boot.
//! - **Non-overwriting:** a row is skipped when a profile of the same name
//!   already exists in JSON, so a user-authored or already-migrated profile is
//!   never clobbered.
//! - **Self-guarding:** the table's existence is the "needs migrating" flag —
//!   once dropped, subsequent boots are a no-op.
//! - **Best-effort:** failures are logged, never block startup.

use serde_json::Value;
use sqlx::SqlitePool;
use tracing::{info, warn};

use crate::domain::settings_store;
use crate::shared::migrate::table_exists;

use super::security::is_denied_env_key;
use super::{DEFAULT_PROFILE_NAME, PROFILES_KEY};

const LEGACY_TABLE: &str = "claude_code_profiles";

/// Migrate legacy SQLite profiles into JSON settings, then drop the table.
pub async fn migrate_from_sqlite(pool: &SqlitePool) {
    match run(pool).await {
        Ok(0) => {}
        Ok(n) => info!(
            count = n,
            "migrated Claude Code profiles from SQLite to JSON settings"
        ),
        Err(e) => warn!("Claude Code profile migration: {e}"),
    }
}

async fn run(pool: &SqlitePool) -> Result<usize, String> {
    if !table_exists(pool, LEGACY_TABLE)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(0);
    }

    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT name, env_json FROM claude_code_profiles ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Skip rows whose name already exists in JSON so a re-run (or a profile the
    // user created in JSON) is never overwritten. Also skip the reserved
    // `default` name, which the resolvers ignore and `upsert_profile` rejects.
    let existing = settings_store::global_get_object(PROFILES_KEY);
    let to_insert: Vec<(String, Value)> = rows
        .into_iter()
        .filter(|(name, _)| {
            if name.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
                warn!(profile = %name, "skipping legacy profile with reserved name 'default'");
                return false;
            }
            !existing.contains_key(name)
        })
        .map(|(name, env_json)| (name, parse_env(&env_json)))
        .collect();
    let migrated = to_insert.len();

    if migrated > 0 {
        settings_store::global_modify_object(PROFILES_KEY, move |obj| {
            for (name, env) in to_insert {
                obj.insert(name, env);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    // Data is safely in JSON (or there was none) — drop the legacy table.
    sqlx::query("DROP TABLE IF EXISTS claude_code_profiles")
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(migrated)
}

/// Parse a legacy `env_json` string into a JSON object value, keeping only
/// string-valued entries and dropping any denied env key (defense-in-depth: a
/// hand-edited legacy DB could hold a key `upsert_profile` would have rejected).
/// Malformed or non-object JSON degrades to an empty object rather than failing
/// the whole migration.
fn parse_env(env_json: &str) -> Value {
    let parsed: Value = serde_json::from_str(env_json).unwrap_or(Value::Null);
    let Value::Object(obj) = parsed else {
        return Value::Object(serde_json::Map::new());
    };
    let kept = obj
        .into_iter()
        .filter(|(k, v)| {
            if is_denied_env_key(k) {
                warn!(env_key = %k, "dropping denied env key from migrated profile");
                return false;
            }
            v.is_string()
        })
        .collect::<serde_json::Map<String, Value>>();
    Value::Object(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool_with_table() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE claude_code_profiles (\
                id INTEGER PRIMARY KEY, \
                name TEXT NOT NULL UNIQUE, \
                env_json TEXT NOT NULL DEFAULT '{}'\
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn migrates_rows_and_drops_table() {
        let pool = pool_with_table().await;
        sqlx::query(
            "INSERT INTO claude_code_profiles (name, env_json) VALUES \
             ('bedrock', '{\"AWS_REGION\":\"us-east-1\",\"CLAUDE_CODE_USE_BEDROCK\":\"1\"}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        migrate_from_sqlite(&pool).await;

        let section = settings_store::global_get_object(PROFILES_KEY);
        assert_eq!(
            section["bedrock"]["AWS_REGION"],
            serde_json::json!("us-east-1")
        );
        assert_eq!(
            section["bedrock"]["CLAUDE_CODE_USE_BEDROCK"],
            serde_json::json!("1")
        );
        assert!(!table_exists(&pool, LEGACY_TABLE).await.unwrap());
    }

    #[tokio::test]
    async fn does_not_overwrite_existing_json_profile() {
        let pool = pool_with_table().await;
        sqlx::query("INSERT INTO claude_code_profiles (name, env_json) VALUES ('bedrock', '{\"AWS_REGION\":\"sql\"}')")
            .execute(&pool)
            .await
            .unwrap();
        // A profile of the same name already exists in JSON.
        settings_store::global_modify_object(PROFILES_KEY, |obj| {
            obj.insert(
                "bedrock".into(),
                serde_json::json!({ "AWS_REGION": "json" }),
            );
            Ok(())
        })
        .await
        .unwrap();

        migrate_from_sqlite(&pool).await;

        let section = settings_store::global_get_object(PROFILES_KEY);
        assert_eq!(section["bedrock"]["AWS_REGION"], serde_json::json!("json"));
        assert!(!table_exists(&pool, LEGACY_TABLE).await.unwrap());
    }

    #[tokio::test]
    async fn drops_denied_env_keys_from_migrated_rows() {
        let pool = pool_with_table().await;
        sqlx::query(
            "INSERT INTO claude_code_profiles (name, env_json) VALUES \
             ('bedrock', '{\"AWS_REGION\":\"us-east-1\",\"PATH\":\"/evil\",\"LD_PRELOAD\":\"x.so\"}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        migrate_from_sqlite(&pool).await;

        let section = settings_store::global_get_object(PROFILES_KEY);
        assert_eq!(
            section["bedrock"]["AWS_REGION"],
            serde_json::json!("us-east-1")
        );
        assert!(section["bedrock"].get("PATH").is_none());
        assert!(section["bedrock"].get("LD_PRELOAD").is_none());
    }

    #[tokio::test]
    async fn skips_reserved_default_name_row() {
        let pool = pool_with_table().await;
        sqlx::query(
            "INSERT INTO claude_code_profiles (name, env_json) VALUES ('default', '{\"AWS_REGION\":\"x\"}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        migrate_from_sqlite(&pool).await;

        assert!(settings_store::global_get_object(PROFILES_KEY).is_empty());
        assert!(!table_exists(&pool, LEGACY_TABLE).await.unwrap());
    }

    #[tokio::test]
    async fn empty_table_just_drops() {
        let pool = pool_with_table().await;
        migrate_from_sqlite(&pool).await;
        assert!(!table_exists(&pool, LEGACY_TABLE).await.unwrap());
        assert!(settings_store::global_get_object(PROFILES_KEY).is_empty());
    }

    #[tokio::test]
    async fn missing_table_is_noop() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // No table created — must not panic or error.
        migrate_from_sqlite(&pool).await;
        assert!(!table_exists(&pool, LEGACY_TABLE).await.unwrap());
    }
}
