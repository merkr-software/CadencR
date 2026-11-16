//! The project a custom tab is built in (`docs/CUSTOM_TABS.md` §8).
//!
//! A tab folder is an ordinary user project — `kind = 'user'` with
//! `authoring_target = 'tab'` and `plugin_id = <id>` — holding one
//! conversation, with worktrees off; the steps are the ones theme authoring
//! shares (`projects::authoring_workspace`).

use axum::http::StatusCode;
use sqlx::SqlitePool;

use super::models::PluginTabWorkspace;
use super::paths;
use super::registry::{self, LocalTab};
use crate::domain::projects::authoring_workspace::{self, AuthoredFolder};
use crate::domain::projects::models::ProjectAuthoringTarget;
use crate::error::AppError;
use crate::shared::git_cli::ensure_repository_with_initial_commit;

/// Cadencr authors a tab folder's first commit itself.
pub const COMMIT_EMAIL: &str = "plugins@cadencr.local";
pub const INITIAL_COMMIT_MESSAGE: &str = "New custom tab";

/// The tab's project and conversation, created on first use. Idempotent: the
/// same tab always resolves to the same project and conversation.
pub async fn ensure(pool: &SqlitePool, plugin_id: &str) -> Result<PluginTabWorkspace, AppError> {
    ensure_for(pool, &registry::get(plugin_id).await?).await
}

/// [`ensure`] for a tab the caller already inspected. Also makes the folder a
/// repository when it is not one yet (a folder created or copied by hand), so
/// the Git tab can show what the agent changed.
pub async fn ensure_for(pool: &SqlitePool, tab: &LocalTab) -> Result<PluginTabWorkspace, AppError> {
    let plugin_id = tab.id.as_str();
    if !paths::tabs_dir().join(plugin_id).is_dir() {
        return Err(AppError::BadRequest(
            "marketplace tabs are immutable; author a separate local tab to modify one".into(),
        ));
    }
    let dir = paths::plugin_dir(plugin_id)?;
    let cwd = dir.to_string_lossy().to_string();
    let label = tab.manifest().map(|manifest| manifest.name.trim());
    let folder = AuthoredFolder {
        target: ProjectAuthoringTarget::Tab,
        plugin_id,
        cwd: &cwd,
        legacy_kind: None,
        conflict,
    };
    let existing = folder.find_project(pool).await?;
    ensure_repository_with_initial_commit(&dir, COMMIT_EMAIL, INITIAL_COMMIT_MESSAGE).await?;
    let name = authoring_workspace::prefixed_name("Tab", label, plugin_id);
    let project_id = folder.ensure_project(pool, existing, &name).await?;
    let title = label.filter(|label| !label.is_empty()).unwrap_or(plugin_id);
    let (feature_id, _) = authoring_workspace::ensure_conversation(pool, project_id, title).await?;
    authoring_workspace::apply_worktree_skip(pool, project_id, feature_id).await?;
    Ok(PluginTabWorkspace {
        plugin_id: plugin_id.to_string(),
        project_id,
        feature_id,
        dir: cwd,
    })
}

/// The project authoring tab `plugin_id`, if Cadencr created one.
pub async fn owner_project(pool: &SqlitePool, plugin_id: &str) -> Result<Option<i64>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM projects WHERE authoring_target = 'tab' AND plugin_id = ?",
    )
    .bind(plugin_id)
    .fetch_optional(pool)
    .await?)
}

fn conflict(plugin_id: &str, reason: &str) -> AppError {
    AppError::coded(
        StatusCode::CONFLICT,
        "PLUGIN_TAB_PROJECT_OWNERSHIP_CONFLICT",
        format!("cannot open custom tab `{plugin_id}` because {reason}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::{pool, write_tab};

    #[tokio::test]
    async fn creates_once_and_reuses_a_marked_skip_worktree_project() {
        let pool = pool().await;
        let dir = write_tab("graph", serde_json::json!({}));
        let first = ensure(&pool, "graph").await.unwrap();
        let second = ensure(&pool, "graph").await.unwrap();
        assert_eq!(
            (first.project_id, first.feature_id),
            (second.project_id, second.feature_id)
        );
        // A hand-made folder becomes a committed repository.
        let log = crate::shared::git_cli::run_git(&["log", "--oneline"], &dir)
            .await
            .unwrap();
        assert!(log.contains(INITIAL_COMMIT_MESSAGE), "{log}");
        // A creation that loses a race resolves to the winner's project.
        let cwd = paths::plugin_dir("graph")
            .unwrap()
            .to_string_lossy()
            .to_string();
        let folder = AuthoredFolder {
            target: ProjectAuthoringTarget::Tab,
            plugin_id: "graph",
            cwd: &cwd,
            legacy_kind: None,
            conflict,
        };
        assert_eq!(
            folder
                .ensure_project(&pool, None, "Tab: Graph")
                .await
                .unwrap(),
            first.project_id
        );
        assert_eq!(
            owner_project(&pool, "graph").await.unwrap(),
            Some(first.project_id)
        );
        let marker: (String, String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT name, kind, authoring_target, plugin_id FROM projects WHERE id = ?",
        )
        .bind(first.project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            marker,
            (
                "Tab: Changed files graph".into(),
                "user".into(),
                Some("tab".into()),
                Some("graph".into())
            )
        );
        let mode: String = sqlx::query_scalar(
            "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_mode'",
        )
        .bind(first.feature_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(mode, "skip");
    }

    #[tokio::test]
    async fn refuses_a_folder_owned_by_an_unmarked_project() {
        let pool = pool().await;
        let dir = write_tab("graph", serde_json::json!({}));
        sqlx::query("INSERT INTO projects (name, path) VALUES ('Mine', ?)")
            .bind(dir.canonicalize().unwrap().to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            ensure(&pool, "graph").await,
            Err(AppError::Coded {
                code: "PLUGIN_TAB_PROJECT_OWNERSHIP_CONFLICT",
                ..
            })
        ));
    }
}
