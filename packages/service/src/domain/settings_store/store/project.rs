//! Project settings wrappers over the dir-based core functions. The file path
//! derives from the project name (see `paths::project_file`).

use std::collections::BTreeMap;
use std::path::PathBuf;

use sqlx::SqlitePool;

use crate::domain::projects::models::ProjectSetting;
use crate::error::AppError;

use super::super::{dir, paths, Scope, SettingWarning};
use super::{load, read_for_edit, set_value, write_content};

pub async fn project_path(pool: &SqlitePool, project_id: i64) -> Result<PathBuf, AppError> {
    paths::project_file(&dir::global_dir(), pool, project_id).await
}

pub async fn project_map(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<(BTreeMap<String, String>, Vec<SettingWarning>), AppError> {
    let path = project_path(pool, project_id).await?;
    Ok(load(&path, Scope::Project))
}

pub async fn project_get(
    pool: &SqlitePool,
    project_id: i64,
    key: &str,
) -> Result<Option<String>, AppError> {
    Ok(project_map(pool, project_id).await?.0.remove(key))
}

pub async fn project_list(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectSetting>, AppError> {
    let (map, _warnings) = project_map(pool, project_id).await?;
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

pub async fn project_write_content(
    pool: &SqlitePool,
    project_id: i64,
    content: &str,
) -> Result<Vec<SettingWarning>, AppError> {
    let path = project_path(pool, project_id).await?;
    write_content(&path, Scope::Project, content).await
}

pub async fn project_read_for_edit(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<(PathBuf, String, Vec<SettingWarning>), AppError> {
    let path = project_path(pool, project_id).await?;
    let (content, warnings) = read_for_edit(&path, Scope::Project);
    Ok((path, content, warnings))
}
