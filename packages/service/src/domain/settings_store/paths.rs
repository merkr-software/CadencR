//! Resolve settings file paths within the settings directory.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::error::AppError;

pub const GLOBAL_FILE_NAME: &str = "settings.json";
const PROJECT_SUFFIX: &str = ".settings.json";

/// Path to the global settings file.
pub fn global_file(dir: &Path) -> PathBuf {
    dir.join(GLOBAL_FILE_NAME)
}

/// Sanitize a project name into a filesystem-safe stem: ASCII alphanumerics and
/// `-`/`_` are kept, every other run of characters collapses to a single `-`,
/// and leading/trailing `-` are trimmed. Guarantees a non-empty, traversal-safe
/// stem (`..`, `/`, etc. can never survive).
pub fn sanitize_stem(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed
    }
}

/// Look up a single project's name.
pub(super) async fn project_name(pool: &SqlitePool, project_id: i64) -> Result<String, AppError> {
    sqlx::query_as::<_, (String,)>("SELECT name FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await?
        .map(|r| r.0)
        .ok_or_else(|| AppError::NotFound(format!("project {project_id} not found")))
}

/// Resolve the settings file path for a project: `<sanitized-name>.settings.json`.
///
/// The path derives only from the project's (sanitized) name, so it is stable —
/// it never shifts as other projects are created or deleted. Project names are
/// not unique, and that is intentional here: same name = same configuration
/// file. Two projects sharing a name share one settings document.
pub async fn project_file(
    dir: &Path,
    pool: &SqlitePool,
    project_id: i64,
) -> Result<PathBuf, AppError> {
    Ok(project_file_for_name(
        dir,
        &project_name(pool, project_id).await?,
    ))
}

/// The settings file a project *named* `name` resolves to, without asking the
/// database. A rename needs both the file the old name points at and the one
/// the new name will point at, and only one of those is in the `projects` row.
pub fn project_file_for_name(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{}{PROJECT_SUFFIX}", sanitize_stem(name)))
}

/// Whether another project (different id) maps to the same settings file as
/// `project_id` — i.e. resolves to the same sanitized name. Deletion uses this
/// to avoid removing a file a surviving same-named project still relies on.
pub async fn name_is_shared(pool: &SqlitePool, project_id: i64) -> Result<bool, AppError> {
    let name = project_name(pool, project_id).await?;
    name_is_shared_for(pool, project_id, &name).await
}

pub(super) async fn name_is_shared_for(
    pool: &SqlitePool,
    project_id: i64,
    name: &str,
) -> Result<bool, AppError> {
    let target = sanitize_stem(name);
    let others = sqlx::query_as::<_, (String,)>("SELECT name FROM projects WHERE id != ?")
        .bind(project_id)
        .fetch_all(pool)
        .await?;
    Ok(others.iter().any(|(n,)| sanitize_stem(n) == target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[test]
    fn sanitizes_unsafe_names() {
        assert_eq!(sanitize_stem("My Project"), "My-Project");
        assert_eq!(sanitize_stem("a/../b"), "a-b");
        assert_eq!(sanitize_stem("...."), "project");
        assert_eq!(sanitize_stem("clean_name-1"), "clean_name-1");
        assert_eq!(sanitize_stem("  spaced  "), "spaced");
    }

    async fn pool_with_projects(rows: &[(i64, &str)]) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '')")
            .execute(&pool)
            .await
            .unwrap();
        for (id, name) in rows {
            sqlx::query("INSERT INTO projects (id, name, path) VALUES (?, ?, '/tmp')")
                .bind(id)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn project_file_derives_from_name() {
        let pool = pool_with_projects(&[(1, "Alpha")]).await;
        let path = project_file(Path::new("/s"), &pool, 1).await.unwrap();
        assert_eq!(path, PathBuf::from("/s/Alpha.settings.json"));
    }

    #[tokio::test]
    async fn same_name_projects_share_one_file() {
        // Same name = same configuration: the path depends only on the name, so
        // two same-named projects resolve to the identical file regardless of id.
        let pool = pool_with_projects(&[(1, "App"), (2, "App")]).await;
        let p1 = project_file(Path::new("/s"), &pool, 1).await.unwrap();
        let p2 = project_file(Path::new("/s"), &pool, 2).await.unwrap();
        assert_eq!(p1, PathBuf::from("/s/App.settings.json"));
        assert_eq!(p2, p1);
    }

    #[tokio::test]
    async fn name_is_shared_detects_siblings() {
        let pool = pool_with_projects(&[(1, "App"), (2, "App"), (3, "Other")]).await;
        // 1 and 2 share the name "App".
        assert!(name_is_shared(&pool, 1).await.unwrap());
        assert!(name_is_shared(&pool, 2).await.unwrap());
        // 3 is unique.
        assert!(!name_is_shared(&pool, 3).await.unwrap());
    }

    #[tokio::test]
    async fn name_is_shared_matches_after_sanitization() {
        // "My App" and "My-App" both sanitize to "My-App", so they share a file.
        let pool = pool_with_projects(&[(1, "My App"), (2, "My-App")]).await;
        assert!(name_is_shared(&pool, 1).await.unwrap());
    }

    #[tokio::test]
    async fn project_file_missing_project_errors() {
        let pool = pool_with_projects(&[]).await;
        assert!(project_file(Path::new("/s"), &pool, 99).await.is_err());
    }
}
