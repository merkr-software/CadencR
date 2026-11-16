//! Project settings wrappers over the dir-based core functions. The file path
//! derives from the project name (see `paths::project_file`).

use std::collections::BTreeMap;
use std::path::PathBuf;

use sqlx::SqlitePool;

use crate::domain::projects::models::ProjectSetting;
use crate::error::AppError;

use super::super::{dir, lock, paths, Scope, SettingWarning};
use super::{load, read_for_edit, set_value, set_values, write_content};

pub async fn project_path(pool: &SqlitePool, project_id: i64) -> Result<PathBuf, AppError> {
    paths::project_file(&dir::global_dir(), pool, project_id).await
}

/// The project document's path and validated scalar values (plus warnings).
pub async fn project_map(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<(PathBuf, BTreeMap<String, String>, Vec<SettingWarning>), AppError> {
    let path = project_path(pool, project_id).await?;
    let (map, warnings) = load(&path, Scope::Project);
    Ok((path, map, warnings))
}

pub async fn project_get(
    pool: &SqlitePool,
    project_id: i64,
    key: &str,
) -> Result<Option<String>, AppError> {
    Ok(project_map(pool, project_id).await?.1.remove(key))
}

pub async fn project_list(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectSetting>, AppError> {
    let (_path, map, _warnings) = project_map(pool, project_id).await?;
    Ok(map
        .into_iter()
        .map(|(key, value)| ProjectSetting {
            key,
            value: Some(value),
        })
        .collect())
}

pub async fn project_set(
    pool: &SqlitePool,
    project_id: i64,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    let path = project_path(pool, project_id).await?;
    set_value(&path, key, value).await
}

/// Set or remove (`None`) several project keys in one atomic write, returning
/// each key's previous stored value.
pub async fn project_set_many(
    pool: &SqlitePool,
    project_id: i64,
    entries: &BTreeMap<String, Option<String>>,
) -> Result<BTreeMap<String, Option<String>>, AppError> {
    let path = project_path(pool, project_id).await?;
    set_values(&path, entries).await
}

pub async fn project_write_content(
    pool: &SqlitePool,
    project_id: i64,
    content: &str,
) -> Result<Vec<SettingWarning>, AppError> {
    let path = project_path(pool, project_id).await?;
    write_content(&path, Scope::Project, content).await
}

/// Carry a project's settings document over to the name it is about to have.
///
/// The file is named after the project, so a rename moves where the app looks
/// for it — every setting on that project would otherwise be stranded in a file
/// nothing reads again. Call this *before* the name changes in the database.
///
/// Two cases leave the document where it is, both because the alternative would
/// take settings away from a project that is still using them:
///  - another project still answers to the old name → the document is copied,
///    not moved;
///  - a document already exists under the new name → the project joins it,
///    which is what "same name = same configuration file" means everywhere else.
pub async fn project_rename(
    pool: &SqlitePool,
    project_id: i64,
    new_name: &str,
) -> Result<(), AppError> {
    let from = project_path(pool, project_id).await?;
    let to = paths::project_file_for_name(&dir::global_dir(), new_name);
    if from == to {
        return Ok(());
    }
    let shared = paths::name_is_shared(pool, project_id).await?;
    let _guard = lock::write_lock().lock().await;
    if !from.exists() || to.exists() {
        return Ok(());
    }
    let moved = if shared {
        std::fs::copy(&from, &to).map(|_| ())
    } else {
        std::fs::rename(&from, &to)
    };
    moved.map_err(|e| {
        AppError::internal(format!(
            "failed to move project settings from {} to {}: {e}",
            from.display(),
            to.display()
        ))
    })
}

pub async fn project_read_for_edit(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<(PathBuf, String, Vec<SettingWarning>), AppError> {
    let path = project_path(pool, project_id).await?;
    let (content, warnings) = read_for_edit(&path, Scope::Project);
    Ok((path, content, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rename is applied to the row afterwards, exactly as the caller does
    /// it — the document has to move first, while the old name still resolves.
    async fn rename(pool: &SqlitePool, project_id: i64, to: &str) {
        project_rename(pool, project_id, to).await.expect("renames");
        sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
            .bind(to)
            .bind(project_id)
            .execute(pool)
            .await
            .expect("renames the row");
    }

    async fn pool_with(names: &[(i64, &str)]) -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        for (id, name) in names {
            sqlx::query("INSERT INTO projects (id, name) VALUES (?, ?)")
                .bind(id)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn settings_follow_the_project_to_its_new_name() {
        let pool = pool_with(&[(1, "Alpha")]).await;
        project_set(&pool, 1, "model_session", "opus")
            .await
            .unwrap();

        rename(&pool, 1, "Beta").await;

        assert_eq!(
            project_get(&pool, 1, "model_session").await.unwrap(),
            Some("opus".to_string())
        );
        assert!(!dir::global_dir().join("Alpha.settings.json").exists());
    }

    #[tokio::test]
    async fn a_project_still_using_the_old_name_keeps_its_settings() {
        // Same name = same document, so moving it away would silently
        // reconfigure the project left behind. It gets a copy instead.
        let pool = pool_with(&[(1, "Alpha"), (2, "Alpha")]).await;
        project_set(&pool, 1, "model_session", "opus")
            .await
            .unwrap();

        rename(&pool, 1, "Beta").await;

        assert_eq!(
            project_get(&pool, 2, "model_session").await.unwrap(),
            Some("opus".to_string()),
            "the project that kept the name kept its settings"
        );
        assert_eq!(
            project_get(&pool, 1, "model_session").await.unwrap(),
            Some("opus".to_string())
        );
    }

    #[tokio::test]
    async fn renaming_onto_an_existing_document_joins_it() {
        let pool = pool_with(&[(1, "Alpha"), (2, "Beta")]).await;
        project_set(&pool, 1, "model_session", "opus")
            .await
            .unwrap();
        project_set(&pool, 2, "model_session", "sonnet")
            .await
            .unwrap();

        rename(&pool, 1, "Beta").await;

        // Everywhere else in the app, two projects of one name share one
        // configuration file. A rename can't be the exception that overwrites
        // the settings of the project already answering to that name.
        assert_eq!(
            project_get(&pool, 1, "model_session").await.unwrap(),
            Some("sonnet".to_string())
        );
    }

    #[tokio::test]
    async fn a_rename_that_does_not_change_the_file_name_is_a_no_op() {
        // Both sanitize to `My-App`, so there is nothing to move — and trying
        // would delete the only copy.
        let pool = pool_with(&[(1, "My App")]).await;
        project_set(&pool, 1, "model_session", "opus")
            .await
            .unwrap();

        rename(&pool, 1, "My-App").await;

        assert_eq!(
            project_get(&pool, 1, "model_session").await.unwrap(),
            Some("opus".to_string())
        );
    }
}
