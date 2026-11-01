use std::path::PathBuf;

use super::models::{Project, ProjectAuthoringTarget, ProjectSetting};
use super::repository;
use crate::error::AppError;
use crate::shared::slug::slugify;
use sqlx::SqlitePool;

pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<Project>, AppError> {
    repository::list_projects(pool).await
}

/// `AppError::NotFound` unless project `project_id` exists. Generic over the
/// executor so a caller can check inside its own transaction.
pub async fn ensure_project_exists<'e, E>(executor: E, project_id: i64) -> Result<(), AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)")
        .bind(project_id)
        .fetch_one(executor)
        .await?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "project {project_id} not found"
        )))
    }
}

/// Resolve a project id to its on-disk canonical root. Returns
/// `AppError::NotFound` if the id is unknown and `AppError::BadRequest` if the
/// stored path can no longer be canonicalized (project was moved or removed).
pub async fn resolve_project_root(pool: &SqlitePool, project_id: i64) -> Result<PathBuf, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT path FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await?;
    let (path,) =
        row.ok_or_else(|| AppError::NotFound(format!("project {project_id} not found")))?;
    std::fs::canonicalize(&path)
        .map_err(|e| AppError::BadRequest(format!("cannot resolve project {project_id} root: {e}")))
}

/// Resolve the on-disk root a feature's editor should operate against. If the
/// feature has a live worktree (its `worktree_path` setting points to an
/// existing directory) we return the canonical worktree path; otherwise we
/// fall back to the project's root. A supplied feature must belong to the
/// supplied project; request authentication does not make cross-object ids
/// trustworthy.
pub async fn resolve_feature_editor_root(
    pool: &SqlitePool,
    project_id: i64,
    feature_id: Option<i64>,
) -> Result<PathBuf, AppError> {
    if let Some(fid) = feature_id {
        crate::domain::features::service::ensure_belongs_to_project(pool, fid, project_id).await?;
    }

    let project_root = resolve_project_root(pool, project_id).await?;
    if let Some(fid) = feature_id {
        let project_path = project_root.to_string_lossy();
        if let Some(path) =
            crate::domain::workflow::worktree::resolve_live_worktree(pool, fid, &project_path)
                .await
                .map_err(AppError::Internal)?
        {
            return std::fs::canonicalize(&path).map_err(|e| {
                AppError::BadRequest(format!("cannot resolve feature {fid} worktree root: {e}"))
            });
        }
    }
    Ok(project_root)
}

pub async fn create_project(
    pool: &SqlitePool,
    name: &str,
    path: &str,
) -> Result<Project, AppError> {
    let (clean_name, canonical_path) = validate_new_project(name, path)?;
    let project = repository::create_project(pool, &clean_name, &canonical_path).await?;
    crate::domain::telemetry::product(crate::domain::telemetry::models::ProductEvent::ProjectAdded);
    Ok(project)
}

/// Create a first-class user project that owns one locally-authored plugin.
///
/// This is intentionally separate from the public ordinary-project API so a
/// caller cannot forge authoring provenance in `CreateProjectRequest`.
#[bon::builder]
pub async fn create_author_project(
    pool: &SqlitePool,
    name: &str,
    path: &str,
    authoring_target: ProjectAuthoringTarget,
    plugin_id: &str,
) -> Result<Project, AppError> {
    let (clean_name, canonical_path) = validate_new_project(name, path)?;
    validate_plugin_id(authoring_target, plugin_id)?;
    repository::create_author_project()
        .pool(pool)
        .name(&clean_name)
        .path(&canonical_path)
        .authoring_target(authoring_target)
        .plugin_id(plugin_id)
        .call()
        .await
}

/// A plugin id in the target's own grammar. Tab ids are URL host labels
/// (inner `--` allowed, up to 64 bytes), which a slug round-trip would refuse;
/// theme and provider ids are stable slugs.
fn validate_plugin_id(target: ProjectAuthoringTarget, plugin_id: &str) -> Result<(), AppError> {
    let valid = match target {
        ProjectAuthoringTarget::Tab => cadencr_plugin_core::tab::is_valid_tab_id(plugin_id),
        ProjectAuthoringTarget::Theme | ProjectAuthoringTarget::Provider => {
            !plugin_id.is_empty() && slugify(plugin_id) == plugin_id
        }
    };
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "plugin id must be a stable slug".into(),
        ))
    }
}

/// Reject names with path-y shapes (`..`, `/`, leading `.`) and canonicalize
/// the on-disk path, confirming it is an existing directory. Returns the
/// trimmed name + canonical path string to persist.
fn validate_new_project(name: &str, path: &str) -> Result<(String, String), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "project name must not be empty".into(),
        ));
    }
    if trimmed.starts_with('.') {
        return Err(AppError::BadRequest(
            "project name must not start with '.'".into(),
        ));
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains('\0')
    {
        return Err(AppError::BadRequest(
            "project name must not contain path separators or '..'".into(),
        ));
    }
    // Slug must round-trip: ensures the name is something the worktree layer
    // can safely place on disk without further escaping.
    if slugify(trimmed).is_empty() {
        return Err(AppError::BadRequest(
            "project name must contain alphanumeric characters".into(),
        ));
    }

    let canonical = std::fs::canonicalize(path)
        .map_err(|e| AppError::BadRequest(format!("invalid project path: {e}")))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| AppError::BadRequest(format!("cannot stat project path: {e}")))?;
    if !meta.is_dir() {
        return Err(AppError::BadRequest(
            "project path must be an existing directory".into(),
        ));
    }

    Ok((
        trimmed.to_string(),
        canonical.to_string_lossy().into_owned(),
    ))
}

pub async fn delete_project(pool: &SqlitePool, id: i64) -> Result<Vec<i64>, AppError> {
    repository::delete_project(pool, id).await
}

pub async fn get_project_settings(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectSetting>, AppError> {
    repository::get_project_settings(pool, project_id).await
}

pub async fn set_project_setting(
    pool: &SqlitePool,
    project_id: i64,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    repository::set_project_setting(pool, project_id, key, value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn creates_tagged_author_project_as_ordinary_user_project() {
        let pool = migrated_pool().await;
        let directory = tempfile::tempdir().unwrap();
        let project = create_author_project()
            .pool(&pool)
            .name("Provider: Acme")
            .path(directory.path().to_str().unwrap())
            .authoring_target(ProjectAuthoringTarget::Provider)
            .plugin_id("acme-provider")
            .call()
            .await
            .unwrap();

        assert_eq!(
            project.authoring_target,
            Some(ProjectAuthoringTarget::Provider)
        );
        assert_eq!(project.plugin_id.as_deref(), Some("acme-provider"));
        let kind: String = sqlx::query_scalar("SELECT kind FROM projects WHERE id = ?")
            .bind(project.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(kind, "user");
        let listed = list_projects(&pool).await.unwrap();
        assert_eq!(listed[0].authoring_target, project.authoring_target);
        assert_eq!(listed[0].plugin_id, project.plugin_id);
    }

    #[tokio::test]
    async fn rejects_invalid_or_conflicting_authoring_identity() {
        let pool = migrated_pool().await;
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let invalid = create_author_project()
            .pool(&pool)
            .name("Invalid")
            .path(first.path().to_str().unwrap())
            .authoring_target(ProjectAuthoringTarget::Theme)
            .plugin_id("Not Stable")
            .call()
            .await;
        assert!(matches!(invalid, Err(AppError::BadRequest(_))));

        create_author_project()
            .pool(&pool)
            .name("Theme: Acme")
            .path(first.path().to_str().unwrap())
            .authoring_target(ProjectAuthoringTarget::Theme)
            .plugin_id("acme")
            .call()
            .await
            .unwrap();
        let duplicate = create_author_project()
            .pool(&pool)
            .name("Theme: Acme Again")
            .path(second.path().to_str().unwrap())
            .authoring_target(ProjectAuthoringTarget::Theme)
            .plugin_id("acme")
            .call()
            .await;
        assert!(duplicate.is_err());
    }

    #[tokio::test]
    async fn accepts_numeric_leading_theme_slug() {
        let pool = migrated_pool().await;
        let directory = tempfile::tempdir().unwrap();
        let project = create_author_project()
            .pool(&pool)
            .name("Theme: 2026")
            .path(directory.path().to_str().unwrap())
            .authoring_target(ProjectAuthoringTarget::Theme)
            .plugin_id("2026-theme")
            .call()
            .await
            .unwrap();
        assert_eq!(project.plugin_id.as_deref(), Some("2026-theme"));
    }

    #[test]
    fn plugin_ids_follow_their_targets_grammar() {
        let long = format!("{}-2", "a".repeat(50));
        for tab_id in ["a--b", long.as_str(), &"a".repeat(64)] {
            assert!(validate_plugin_id(ProjectAuthoringTarget::Tab, tab_id).is_ok());
        }
        for bad in ["", "A", "-a", &"a".repeat(65)] {
            assert!(validate_plugin_id(ProjectAuthoringTarget::Tab, bad).is_err());
        }
        for target in [
            ProjectAuthoringTarget::Theme,
            ProjectAuthoringTarget::Provider,
        ] {
            assert!(validate_plugin_id(target, "a--b").is_err());
            assert!(validate_plugin_id(target, "acme-2").is_ok());
        }
    }

    #[tokio::test]
    async fn ensure_project_exists_reports_not_found() {
        let pool = migrated_pool().await;
        assert!(matches!(
            ensure_project_exists(&pool, 404).await,
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn validate_rejects_parent_dir_name() {
        let err = validate_new_project("../evil", "/").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_rejects_slash_in_name() {
        let err = validate_new_project("a/b", "/").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_rejects_leading_dot() {
        let err = validate_new_project(".hidden", "/").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_rejects_empty_name() {
        let err = validate_new_project("   ", "/").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_rejects_non_alphanumeric_name() {
        let err = validate_new_project("!!!", "/").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_rejects_missing_path() {
        let err = validate_new_project("ok", "/nonexistent/xxx/yyy").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_rejects_file_path() {
        let dir = std::env::temp_dir();
        let file = dir.join("cadencr-project-validate-test-file");
        std::fs::write(&file, b"x").unwrap();
        let err = validate_new_project("ok", file.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn validate_canonicalizes_dir() {
        let dir = std::env::temp_dir();
        let (name, canonical) = validate_new_project("  okay  ", dir.to_str().unwrap()).unwrap();
        assert_eq!(name, "okay");
        assert!(!canonical.is_empty());
        let canonical_tmp = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(canonical, canonical_tmp.to_string_lossy().into_owned());
    }

    #[tokio::test]
    async fn editor_root_rejects_cross_project_feature_ids() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (
                feature_id INTEGER NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                PRIMARY KEY (feature_id, key)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        sqlx::query("INSERT INTO projects (id, path) VALUES (1, ?), (2, ?)")
            .bind(first.path().to_string_lossy().as_ref())
            .bind(second.path().to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id) VALUES (7, 1)")
            .execute(&pool)
            .await
            .unwrap();

        assert!(resolve_feature_editor_root(&pool, 1, Some(7)).await.is_ok());
        assert!(matches!(
            resolve_feature_editor_root(&pool, 2, Some(7)).await,
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            resolve_feature_editor_root(&pool, 1, Some(99)).await,
            Err(AppError::NotFound(_))
        ));
    }
}
