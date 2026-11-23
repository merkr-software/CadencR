//! Project settings wrappers over the dir-based core functions. The file path
//! derives from the project name (see `paths::project_file`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tokio::sync::MutexGuard;

use crate::domain::projects::models::ProjectSetting;
use crate::error::AppError;
use crate::shared::no_replace_rename::rename_no_replace;

use super::super::{cache, dir, lock, paths, Scope, SettingWarning};
use super::{load, load_key, read_for_edit, set_value, set_values, write_content};

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
    let path = project_path(pool, project_id).await?;
    Ok(load_key(&path, Scope::Project, key))
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
    set_values(&path, entries)
        .await
        .map(|(previous, _)| previous)
}

pub async fn project_write_content(
    pool: &SqlitePool,
    project_id: i64,
    content: &str,
) -> Result<Vec<SettingWarning>, AppError> {
    let path = project_path(pool, project_id).await?;
    write_content(&path, Scope::Project, content).await
}

/// Keep settings writes serialized until the database has accepted the name
/// or the settings move has been undone.
#[must_use = "hold the settings lock until the database rename finishes"]
pub struct ProjectSettingsRename {
    moved: Option<(PathBuf, PathBuf)>,
    _guard: MutexGuard<'static, ()>,
}

impl ProjectSettingsRename {
    /// Restore only a document that this rename moved. Copies are kept because
    /// their source is already intact and the destination can be shared.
    pub fn undo(self) -> Result<(), AppError> {
        let Some((from, to)) = self.moved else {
            return Ok(());
        };
        rename_no_replace(&to, &from).map_err(|e| {
            AppError::internal(format!(
                "failed to move project settings back from {} to {}: {e}",
                to.display(),
                from.display()
            ))
        })?;
        cache::invalidate_path(&from);
        cache::invalidate_path(&to);
        Ok(())
    }
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
) -> Result<ProjectSettingsRename, AppError> {
    let guard = lock::write_lock().lock().await;
    // Resolve the settings dir on the calling thread before `spawn_blocking`
    // so `cfg(test)`'s thread-local test dir stays intact.
    let dir = dir::global_dir();
    let old_name = paths::project_name(pool, project_id).await?;
    let from = paths::project_file_for_name(&dir, &old_name);
    let to = paths::project_file_for_name(&dir, new_name);
    if from == to {
        return Ok(ProjectSettingsRename {
            moved: None,
            _guard: guard,
        });
    }
    let shared = paths::name_is_shared_for(pool, project_id, &old_name).await?;
    let from_owned = from.clone();
    let to_owned = to.clone();
    // The guard rides along with the move and comes back with its result, so
    // a dropped caller cannot free the lock while the file is being moved.
    let (guard, did_move) = tokio::task::spawn_blocking(move || {
        let moved = move_document(&from_owned, &to_owned, shared);
        (guard, moved)
    })
    .await
    .map_err(|error| AppError::internal(format!("settings rename task failed: {error}")))?;
    let mut rename = ProjectSettingsRename {
        moved: None,
        _guard: guard,
    };
    if did_move? {
        cache::invalidate_path(&from);
        cache::invalidate_path(&to);
        if !shared {
            rename.moved = Some((from, to));
        }
    }
    Ok(rename)
}

/// Copy (when the old name is still in use) or move a project's settings
/// document; `false` when there is nothing to carry or the target exists.
fn move_document(from: &Path, to: &Path, shared: bool) -> Result<bool, AppError> {
    if !from.exists() || to.exists() {
        return Ok(false);
    }
    let moved = if shared {
        std::fs::copy(from, to).map(|_| ())
    } else {
        std::fs::rename(from, to)
    };
    moved.map_err(|e| {
        AppError::internal(format!(
            "failed to move project settings from {} to {}: {e}",
            from.display(),
            to.display()
        ))
    })?;
    Ok(true)
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
        let _settings_rename = project_rename(pool, project_id, to).await.expect("renames");
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
