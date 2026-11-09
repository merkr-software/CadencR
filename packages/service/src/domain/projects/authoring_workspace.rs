//! The project a locally authored plugin (a theme, a custom tab) is built in.
//!
//! Each such plugin folder is an ordinary `kind = 'user'` project marked with
//! `authoring_target` + `plugin_id`, holding one conversation, with worktrees
//! off (`skip`) as the project default and on that conversation: a worktree
//! would hand the agent a *copy*, and the plugin the app loads from the folder
//! would never change. These are the steps every authoring flow shares; the
//! domain keeps its own naming, conflict code and file setup.

use sqlx::SqlitePool;

use super::models::ProjectAuthoringTarget;
use crate::error::AppError;

const DEFAULT_WORKTREE_MODE: &str = "default_worktree_mode";
const WORKTREE_SKIP: &str = "skip";

/// One plugin folder and how its domain reports an ownership conflict.
#[derive(Clone, Copy)]
pub struct AuthoredFolder<'a> {
    pub target: ProjectAuthoringTarget,
    pub plugin_id: &'a str,
    /// The folder as the domain names it; also matched canonicalized.
    pub cwd: &'a str,
    /// Unmarked projects of this `kind` at the folder are adopted as the owner
    /// (legacy `kind = 'theme'` rows predate the marker).
    pub legacy_kind: Option<&'a str>,
    /// `(plugin_id, reason)` → the domain's coded 409.
    pub conflict: fn(&str, &str) -> AppError,
}

impl AuthoredFolder<'_> {
    /// The project that owns this plugin, refusing any ambiguity: a marked
    /// project at another path, two claimants, or the folder belonging to an
    /// unrelated project.
    pub async fn find_project(&self, pool: &SqlitePool) -> Result<Option<i64>, AppError> {
        let target = self.target.as_str();
        let canonical = std::fs::canonicalize(self.cwd)
            .map_err(|error| {
                AppError::internal(format!("canonicalize {target} project path: {error}"))
            })?
            .to_string_lossy()
            .to_string();
        let rows: Vec<(i64, String, String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT id, path, kind, authoring_target, plugin_id FROM projects \
             WHERE (authoring_target = ? AND plugin_id = ?) OR path IN (?, ?) ORDER BY id",
        )
        .bind(target)
        .bind(self.plugin_id)
        .bind(self.cwd)
        .bind(&canonical)
        .fetch_all(pool)
        .await?;
        let mut owned = None;
        for (id, path, kind, row_target, row_plugin) in rows {
            let marked = row_target.as_deref() == Some(target)
                && row_plugin.as_deref() == Some(self.plugin_id);
            let at_folder = path == self.cwd || path == canonical;
            let legacy = at_folder
                && self.legacy_kind == Some(kind.as_str())
                && row_target.is_none()
                && row_plugin.is_none();
            if marked && !at_folder {
                return Err(self.refuse("its marked project points at another path"));
            }
            if !marked && !legacy {
                return Err(self.refuse("its folder belongs to another project"));
            }
            if owned.replace(id).is_some() {
                return Err(self.refuse(&format!("more than one project claims this {target}")));
            }
        }
        Ok(owned)
    }

    /// `existing`, or a newly created marked project. A creation that loses a
    /// race (two concurrent opens) resolves to the winner's project.
    pub async fn ensure_project(
        &self,
        pool: &SqlitePool,
        existing: Option<i64>,
        name: &str,
    ) -> Result<i64, AppError> {
        if let Some(id) = existing {
            return Ok(id);
        }
        let created = super::service::create_author_project()
            .pool(pool)
            .name(name)
            .path(self.cwd)
            .authoring_target(self.target)
            .plugin_id(self.plugin_id)
            .call()
            .await;
        match created {
            Ok(project) => Ok(project.id),
            Err(error) => self.find_project(pool).await?.ok_or(error),
        }
    }

    fn refuse(&self, reason: &str) -> AppError {
        (self.conflict)(self.plugin_id, reason)
    }
}

/// `<prefix>: <label>`. Prefixed because project settings are stored in a file
/// named after the project, so a bare label could share a user project's
/// settings — including the worktree default below. A label a project name may
/// not contain (the shapes `projects::service` rejects) falls back to the id,
/// which is a valid name by construction.
pub fn prefixed_name(prefix: &str, label: Option<&str>, plugin_id: &str) -> String {
    let trimmed = label.unwrap_or_default().trim();
    let usable =
        !trimmed.is_empty() && !trimmed.contains("..") && !trimmed.contains(['/', '\\', '\0']);
    format!("{prefix}: {}", if usable { trimmed } else { plugin_id })
}

/// The project's conversation, and whether this call is what created it.
pub async fn ensure_conversation(
    pool: &SqlitePool,
    project_id: i64,
    title: &str,
) -> Result<(i64, bool), AppError> {
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT id FROM features WHERE project_id = ? ORDER BY id LIMIT 1")
            .bind(project_id)
            .fetch_optional(pool)
            .await?;
    if let Some(id) = existing {
        return Ok((id, false));
    }
    let feature_id: i64 = sqlx::query_scalar(
        "INSERT INTO features (project_id, title, status, type) \
         VALUES (?, ?, 'active', 'ws-session') RETURNING id",
    )
    .bind(project_id)
    .bind(title)
    .fetch_one(pool)
    .await?;
    Ok((feature_id, true))
}

/// Both halves of "edit the plugin where it lives": the project default, so
/// every conversation started here inherits it, and the conversation's own
/// setting. Asserted on every open, so a failure between creating the project
/// and writing these is repaired by the next one.
pub async fn apply_worktree_skip(
    pool: &SqlitePool,
    project_id: i64,
    feature_id: i64,
) -> Result<(), AppError> {
    apply_project_worktree_skip(pool, project_id).await?;
    crate::domain::features::repository::upsert_feature_setting(
        pool,
        feature_id,
        "worktree_mode",
        WORKTREE_SKIP,
    )
    .await
}

/// The project half of [`apply_worktree_skip`].
///
/// Read before write, unlike most setters: the settings dir is watched, and a
/// write that changes nothing still fans a settings refetch across every open
/// conversation. This runs on every open, so the common case has to be silent.
pub async fn apply_project_worktree_skip(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<(), AppError> {
    let current =
        crate::domain::settings_store::project_get(pool, project_id, DEFAULT_WORKTREE_MODE).await?;
    if current.as_deref() == Some(WORKTREE_SKIP) {
        return Ok(());
    }
    super::repository::set_project_setting(pool, project_id, DEFAULT_WORKTREE_MODE, WORKTREE_SKIP)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixed_names_fall_back_to_the_id() {
        assert_eq!(
            prefixed_name("Tab", Some("  Graph "), "graph"),
            "Tab: Graph"
        );
        for label in [None, Some(""), Some("a/b"), Some(".."), Some("a\\b")] {
            assert_eq!(prefixed_name("Tab", label, "graph"), "Tab: graph");
        }
    }
}
