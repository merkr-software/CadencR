use serde::{Deserialize, Serialize};

use super::spawn_session::SpawnSessionRequest;
use super::trimmed_optional;
use crate::app_state::AppState;
use crate::domain::agents::codex::{
    canonical_access_mode_wire, configured_access_mode as configured_codex_access_mode,
    PROVIDER_ID as CODEX_PROVIDER_ID,
};
use crate::domain::agents::providers::{
    canonical_model_or_error, canonical_provider_or_error, resolve_effective_provider,
};
use crate::domain::agents::runtime::{runtime_setting_key, DEFAULT_PROVIDER};
use crate::domain::settings;
use crate::error::AppError;

/// A resolved target project the spawned session will be created in. Also the
/// wire shape returned in the response's `project` field.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub(super) struct TargetProject {
    pub(super) id: i64,
    pub(super) name: String,
    pub(super) path: String,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct SpawnBranch {
    mode: Option<String>,
    base: Option<String>,
    reuse_branch: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct SpawnRuntimeSelection {
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) effective_provider: String,
}

pub(super) fn branch_worktree_settings(
    branch: Option<&SpawnBranch>,
) -> Result<(String, Option<String>, Option<String>), AppError> {
    let default_branch = SpawnBranch::default();
    let branch = branch.unwrap_or(&default_branch);
    let mode = branch.mode.as_deref().unwrap_or("none");
    let worktree_mode = match mode {
        "none" | "skip" => "skip",
        "new" | "new_project_branch" | "new_worktree" => "new",
        "reuse" | "reuse_worktree" => "reuse",
        other => {
            return Err(AppError::BadRequest(format!(
                "unsupported branch mode '{other}'"
            )))
        }
    };
    if worktree_mode == "reuse" && trimmed_optional(branch.reuse_branch.as_deref()).is_none() {
        return Err(AppError::BadRequest(
            "branch.reuse_branch is required for reuse_worktree".to_string(),
        ));
    }
    let base_branch = if worktree_mode == "new" {
        trimmed_optional(branch.base.as_deref())
    } else {
        None
    };
    Ok((
        worktree_mode.to_string(),
        trimmed_optional(branch.reuse_branch.as_deref()),
        base_branch,
    ))
}

/// Resolve the project a spawned session should land in. A target is required:
/// the caller must pass `target_project_id` or `target_project_path` (pass the
/// caller's own project id to spawn locally). Errors are phrased to point the
/// agent at `workspace_list_projects` for valid targets.
pub(super) async fn resolve_target_project(
    pool: &sqlx::SqlitePool,
    target_project_id: Option<i64>,
    target_project_path: Option<&str>,
) -> Result<TargetProject, AppError> {
    let target_path = target_project_path
        .map(str::trim)
        .filter(|path| !path.is_empty());

    let target = match (target_project_id, target_path) {
        (Some(id), _) => fetch_project_by_id(pool, id).await?.ok_or_else(|| {
            AppError::BadRequest(format!(
                "No CadencR project has id {id}. Call workspace_list_projects to see available project ids, names, and paths."
            ))
        })?,
        (None, Some(path)) => fetch_project_by_path(pool, path).await?.ok_or_else(|| {
            AppError::BadRequest(format!(
                "No CadencR project is registered at path '{path}'. The path must exactly match a project root; call workspace_list_projects to see registered project paths."
            ))
        })?,
        (None, None) => {
            return Err(AppError::BadRequest(
                "A target project is required: pass project_id or project_path (call workspace_list_projects to see available projects, then pass the caller's own project id to spawn in the current project)."
                    .to_string(),
            ))
        }
    };

    // When both selectors are supplied the path acts as a confirmation guard so
    // an agent cannot accidentally target the wrong project by a stale id.
    if let (Some(id), Some(path)) = (target_project_id, target_path) {
        if target.path != path {
            return Err(AppError::BadRequest(format!(
                "project_id {id} resolves to path '{}', which does not match the supplied project_path '{path}'. Supply only one of project_id/project_path, or make them consistent.",
                target.path
            )));
        }
    }

    Ok(target)
}

async fn fetch_project_by_id(
    pool: &sqlx::SqlitePool,
    id: i64,
) -> Result<Option<TargetProject>, AppError> {
    Ok(
        sqlx::query_as::<_, TargetProject>("SELECT id, name, path FROM projects WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?,
    )
}

async fn fetch_project_by_path(
    pool: &sqlx::SqlitePool,
    path: &str,
) -> Result<Option<TargetProject>, AppError> {
    Ok(
        sqlx::query_as::<_, TargetProject>("SELECT id, name, path FROM projects WHERE path = ?")
            .bind(path)
            .fetch_optional(pool)
            .await?,
    )
}

pub(super) async fn resolve_spawn_runtime(
    state: &AppState,
    source: &super::scope::SessionScope,
    target_project: &TargetProject,
    body: &SpawnSessionRequest,
) -> Result<SpawnRuntimeSelection, AppError> {
    let provider = trimmed_optional(body.provider.as_deref())
        .map(|provider| canonical_provider_or_error(&provider))
        .transpose()
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let effective_provider = match &provider {
        Some(provider) => provider.clone(),
        None => {
            let raw_provider = effective_spawn_provider(state, source, target_project, body).await;
            canonical_provider_or_error(&raw_provider)
                .map_err(|error| AppError::BadRequest(error.to_string()))?
        }
    };
    let model = match trimmed_optional(body.model.as_deref()) {
        Some(model) => Some(
            canonical_model_or_error(&state.read_pool, &effective_provider, &model)
                .await
                .map_err(|error| AppError::BadRequest(error.to_string()))?,
        ),
        None => None,
    };
    Ok(SpawnRuntimeSelection {
        provider,
        model,
        effective_provider,
    })
}

pub(super) async fn codex_permission_mode_for_spawn(
    state: &AppState,
    runtime: &SpawnRuntimeSelection,
    body: &SpawnSessionRequest,
) -> Result<Option<String>, AppError> {
    if runtime.effective_provider != CODEX_PROVIDER_ID {
        return Ok(None);
    }
    if let Some(raw_mode) = trimmed_optional(body.codex_permission_mode.as_deref()) {
        return canonical_codex_permission_mode(&raw_mode).map(Some);
    }

    let configured = configured_codex_access_mode(&state.read_pool).await;
    canonical_codex_permission_mode(&configured).map(Some)
}

async fn effective_spawn_provider(
    state: &AppState,
    source: &super::scope::SessionScope,
    target_project: &TargetProject,
    body: &SpawnSessionRequest,
) -> String {
    if let Some(provider) = trimmed_optional(body.provider.as_deref()) {
        return provider;
    }
    // Scope the default-provider cascade to the target project. Only inherit the
    // caller's feature-level override when spawning inside the same project.
    let feature_scope = (target_project.id == source.project_id).then_some(source.feature_id);
    let configured = settings::resolve_setting(
        &state.read_pool,
        &runtime_setting_key("session"),
        feature_scope,
        Some(target_project.id),
        Some(DEFAULT_PROVIDER),
    )
    .await
    .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    resolve_effective_provider(configured, body.model.as_deref())
}

fn canonical_codex_permission_mode(raw_mode: &str) -> Result<String, AppError> {
    canonical_access_mode_wire(raw_mode)
        .ok_or_else(|| AppError::BadRequest(format!("unsupported Codex access mode '{raw_mode}'")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_worktree_settings_preserves_base_branch_for_new_worktree() {
        let branch = SpawnBranch {
            mode: Some("new_worktree".to_string()),
            base: Some("main".to_string()),
            reuse_branch: None,
        };

        let settings = branch_worktree_settings(Some(&branch)).unwrap();

        assert_eq!(settings.0, "new");
        assert_eq!(settings.1, None);
        assert_eq!(settings.2.as_deref(), Some("main"));
    }

    async fn seed_projects_pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
            INSERT INTO projects (id, name, path) VALUES
                (7, 'Caller', '/repos/caller'),
                (9, 'Target', '/repos/target');
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn resolve_target_project_requires_a_target() {
        let pool = seed_projects_pool().await;
        let error = resolve_target_project(&pool, None, None).await.unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("project_id or project_path"));
    }

    #[tokio::test]
    async fn resolve_target_project_by_id_selects_project() {
        let pool = seed_projects_pool().await;
        let target = resolve_target_project(&pool, Some(9), None).await.unwrap();
        assert_eq!(target.id, 9);
        assert_eq!(target.name, "Target");
    }

    #[tokio::test]
    async fn resolve_target_project_by_path_selects_project() {
        let pool = seed_projects_pool().await;
        let target = resolve_target_project(&pool, None, Some("  /repos/target  "))
            .await
            .unwrap();
        assert_eq!(target.id, 9);
    }

    #[tokio::test]
    async fn resolve_target_project_unknown_id_points_at_workspace_list() {
        let pool = seed_projects_pool().await;
        let error = resolve_target_project(&pool, Some(404), None)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("workspace_list_projects"));
    }

    #[tokio::test]
    async fn resolve_target_project_unknown_path_points_at_workspace_list() {
        let pool = seed_projects_pool().await;
        let error = resolve_target_project(&pool, None, Some("/nope"))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("workspace_list_projects"));
    }

    #[tokio::test]
    async fn resolve_target_project_rejects_inconsistent_id_and_path() {
        let pool = seed_projects_pool().await;
        let error = resolve_target_project(&pool, Some(9), Some("/repos/caller"))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("does not match"));
    }
}
