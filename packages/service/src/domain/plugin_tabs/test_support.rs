use std::path::PathBuf;

use cadencr_plugin_core::tab::test_support::manifest_json_for;
use serde_json::Value;
use sqlx::SqlitePool;

use super::paths;
use crate::error::AppError;

/// The stable code of a coded error; any other error fails the test.
pub(crate) fn error_code(error: &AppError) -> &'static str {
    match error {
        AppError::Coded { code, .. } => code,
        other => panic!("expected a coded error, got {other:?}"),
    }
}

/// Write `<tabs>/<id>/tab.json` (and an icon) in this test's isolated plugins dir.
pub(crate) fn write_tab(id: &str, overrides: Value) -> PathBuf {
    let dir = paths::tabs_dir().join(id);
    std::fs::create_dir_all(&dir).expect("tab dir");
    std::fs::write(
        dir.join("tab.json"),
        serde_json::to_vec_pretty(&manifest_json_for(id, overrides)).expect("json"),
    )
    .expect("write tab.json");
    std::fs::write(dir.join("icon.svg"), "<svg viewBox=\"0 0 24 24\"></svg>").expect("icon");
    dir
}

pub(crate) async fn pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("pool");
    crate::shared::migrate::run_migrations(&crate::shared::migrate::MigrationContext::pool_only(
        &pool,
    ))
    .await
    .expect("migrations");
    pool
}

pub(crate) async fn insert_project(pool: &SqlitePool, name: &str) -> i64 {
    sqlx::query_scalar("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .bind(name)
        .bind(format!("/tmp/{name}"))
        .fetch_one(pool)
        .await
        .expect("project")
}
