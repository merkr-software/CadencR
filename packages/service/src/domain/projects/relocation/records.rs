//! The database side of a project rename or move, in one transaction.
//!
//! A project records its folder in `projects.path`; a conversation with its
//! own worktree records it in its `worktree_path` setting, which only changes
//! when the worktree lived inside the moved folder (worktrees made by Cadencr
//! live elsewhere and stay where they are).

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::domain::git::service::SETTING_WORKTREE_PATH;
use crate::error::AppError;
use crate::shared::path_rebase::rebase_str;

/// What the project's row becomes. `folder` is `(from, to)`; `from` may be
/// spelled several ways (as recorded, and resolved through symlinks).
pub(super) struct RecordChange<'a> {
    pub(super) name: Option<&'a str>,
    pub(super) folder: Option<(&'a [&'a Path], &'a Path)>,
}

/// Apply `change`. Returns the conversation folders inside the old folder
/// whose records moved with it, as recorded before the change.
pub(super) async fn apply(
    pool: &SqlitePool,
    project_id: i64,
    change: &RecordChange<'_>,
) -> Result<Vec<PathBuf>, AppError> {
    let mut tx = pool.begin().await?;
    if let Some(name) = change.name {
        let updated = sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
            .bind(name)
            .bind(project_id)
            .execute(&mut *tx)
            .await?;
        ensure_found(updated.rows_affected(), project_id)?;
    }
    let mut inner = Vec::new();
    if let Some((spellings, to)) = change.folder {
        let updated = sqlx::query("UPDATE projects SET path = ? WHERE id = ?")
            .bind(to.to_string_lossy().as_ref())
            .bind(project_id)
            .execute(&mut *tx)
            .await?;
        ensure_found(updated.rows_affected(), project_id)?;
        let worktrees: Vec<(i64, String)> = sqlx::query_as(
            "SELECT s.id, s.value FROM feature_settings s \
             JOIN features f ON f.id = s.feature_id \
             WHERE f.project_id = ? AND s.key = ?",
        )
        .bind(project_id)
        .bind(SETTING_WORKTREE_PATH)
        .fetch_all(&mut *tx)
        .await?;
        for (id, value) in worktrees {
            let Some(rebased) = spellings
                .iter()
                .find_map(|from| rebase_str(&value, from, to))
            else {
                continue;
            };
            sqlx::query("UPDATE feature_settings SET value = ? WHERE id = ?")
                .bind(rebased)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            inner.push(PathBuf::from(value));
        }
    }
    tx.commit().await?;
    Ok(inner)
}

/// The project was deleted while its folder moved.
fn ensure_found(rows: u64, project_id: i64) -> Result<(), AppError> {
    if rows == 0 {
        return Err(AppError::NotFound(format!(
            "project {project_id} not found"
        )));
    }
    Ok(())
}

/// Another project whose folder lies inside `folder`: moving `folder` would
/// take it along behind its back.
pub(super) async fn project_inside(
    pool: &SqlitePool,
    folder: &[&Path],
    except: i64,
) -> Result<Option<String>, AppError> {
    let projects: Vec<(String, String)> =
        sqlx::query_as("SELECT name, path FROM projects WHERE id != ?")
            .bind(except)
            .fetch_all(pool)
            .await?;
    Ok(projects.into_iter().find_map(|(name, path)| {
        let path = Path::new(&path);
        folder
            .iter()
            .any(|folder| path != *folder && path.starts_with(folder))
            .then_some(name)
    }))
}

/// Another project already recorded at `path`.
pub(super) async fn project_at(
    pool: &SqlitePool,
    path: &Path,
    except: i64,
) -> Result<Option<String>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT name FROM projects WHERE path = ? AND id != ?")
            .bind(path.to_string_lossy().as_ref())
            .bind(except)
            .fetch_optional(pool)
            .await?,
    )
}

/// Every conversation of the project, archived ones included, as
/// `(id, archived)`.
pub(super) async fn features(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<(i64, bool)>, AppError> {
    Ok(
        sqlx::query_as("SELECT id, status = 'archived' FROM features WHERE project_id = ?")
            .bind(project_id)
            .fetch_all(pool)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }

    async fn insert(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    async fn worktree_path(pool: &SqlitePool, feature_id: i64) -> String {
        sqlx::query_scalar("SELECT value FROM feature_settings WHERE feature_id = ? AND key = ?")
            .bind(feature_id)
            .bind(SETTING_WORKTREE_PATH)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn the_project_and_the_worktrees_inside_it_follow_the_folder() {
        let pool = pool().await;
        let project = insert(
            &pool,
            "INSERT INTO projects (name, path) VALUES ('app', '/repo/app')",
        )
        .await;
        let other = insert(
            &pool,
            "INSERT INTO projects (name, path) VALUES ('other', '/repo/app-other')",
        )
        .await;
        let inside = insert(&pool, &format!("INSERT INTO features (project_id, title, status) VALUES ({project}, 'a', 'active')")).await;
        let outside = insert(&pool, &format!("INSERT INTO features (project_id, title, status) VALUES ({project}, 'b', 'active')")).await;
        let sibling = insert(
            &pool,
            &format!(
                "INSERT INTO features (project_id, title, status) VALUES ({other}, 'c', 'active')"
            ),
        )
        .await;
        for (feature, path) in [
            (inside, "/repo/app/.worktrees/a"),
            (outside, "/home/me/.cadencr/worktrees/app/b"),
            (sibling, "/repo/app/.worktrees/c"),
        ] {
            insert(&pool, &format!("INSERT INTO feature_settings (feature_id, key, value) VALUES ({feature}, '{SETTING_WORKTREE_PATH}', '{path}')")).await;
        }

        let from = [Path::new("/repo/app")];
        let inner = apply(
            &pool,
            project,
            &RecordChange {
                name: Some("renamed"),
                folder: Some((&from, Path::new("/work/renamed"))),
            },
        )
        .await
        .unwrap();

        assert_eq!(inner, vec![PathBuf::from("/repo/app/.worktrees/a")]);

        let (name, path): (String, String) =
            sqlx::query_as("SELECT name, path FROM projects WHERE id = ?")
                .bind(project)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((name.as_str(), path.as_str()), ("renamed", "/work/renamed"));
        assert_eq!(
            worktree_path(&pool, inside).await,
            "/work/renamed/.worktrees/a"
        );
        assert_eq!(
            worktree_path(&pool, outside).await,
            "/home/me/.cadencr/worktrees/app/b"
        );
        assert_eq!(
            worktree_path(&pool, sibling).await,
            "/repo/app/.worktrees/c",
            "another project's records are not touched"
        );
        assert_eq!(
            project_at(&pool, Path::new("/work/renamed"), other)
                .await
                .unwrap(),
            Some("renamed".into())
        );
    }

    #[tokio::test]
    async fn a_project_inside_the_folder_is_found_and_a_deleted_one_refuses_the_change() {
        let pool = pool().await;
        let project = insert(
            &pool,
            "INSERT INTO projects (name, path) VALUES ('app', '/repo/app')",
        )
        .await;
        insert(
            &pool,
            "INSERT INTO projects (name, path) VALUES ('web', '/repo/app/packages/web')",
        )
        .await;
        insert(
            &pool,
            "INSERT INTO projects (name, path) VALUES ('other', '/repo/app-other')",
        )
        .await;

        let inside = |folder: &'static str| {
            let pool = pool.clone();
            async move {
                project_inside(&pool, &[Path::new(folder)], project)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(inside("/repo/app").await, Some("web".into()));
        assert_eq!(inside("/repo/app/packages/web/src").await, None);

        let change = RecordChange {
            name: Some("x"),
            folder: None,
        };
        let error = apply(&pool, 999, &change).await.unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)), "{error:?}");
    }
}
