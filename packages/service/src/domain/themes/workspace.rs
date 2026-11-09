//! The project a theme is built in.
//!
//! A theme is edited the way everything else in Cadencr is edited: in a project,
//! with the file in the editor, an agent beside it and git underneath. Rather
//! than teach the runtime a second notion of "where does this agent run", a
//! theme gets what every conversation already has — a project row whose `path`
//! *is* the theme directory, and a conversation inside it. Every existing path
//! (session init, prompt send, checkpoints, the editor, the Git tab) then works
//! with no special case, and the theme file the app is watching is the very file
//! the agent writes, so the app restyles itself as it is edited.
//!
//! Two pieces of setup are what make that true rather than nearly true:
//!
//!  - The directory is made a git repository. A theme project is a project; the
//!    Git tab is where the user reads what the agent changed and how to undo it.
//!  - Worktrees are off (`skip`, as the feature setting and the project
//!    default). A worktree would hand the agent a *copy* of the theme somewhere
//!    else, and the live app would go on painting from a file nobody edits.
//!
//! New authoring projects remain ordinary `kind = 'user'` projects and carry a
//! typed theme identity. Legacy `kind = 'theme'` rows remain readable without
//! being reclassified or backfilled.

use std::path::Path;

use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::domain::projects::authoring_workspace::{self, AuthoredFolder};
use crate::domain::projects::models::{ProjectAuthoringTarget, THEME_PROJECT_KIND};
use crate::error::AppError;
use crate::shared::git_cli::ensure_repository_with_initial_commit;

use super::{paths, scaffold};

/// Cadencr authors the first commit itself.
const COMMIT_EMAIL: &str = "themes@cadencr.local";

/// Atomic saves stage through `.theme.json.tmp`; it exists for microseconds and
/// is nobody's change.
const GITIGNORE: &str = ".*.tmp\n";

/// Where a theme is edited. The renderer needs all three to route to the
/// conversation; the ws session id is derived from `feature_id`.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct ThemeWorkspace {
    pub project_id: i64,
    pub feature_id: i64,
    /// The theme directory — the project root, and the agent's cwd.
    pub cwd: String,
    /// Whether this call created the conversation. The renderer arranges the
    /// panes — the theme file beside the agent — only on that first open, so a
    /// layout the user rearranged afterwards is theirs to keep.
    pub created: bool,
}

/// The theme's project, creating it if this is the first time the theme has been
/// opened. Idempotent: the same theme always resolves to the same project and
/// conversation, so the work persists across opens.
pub async fn ensure(pool: &SqlitePool, theme_id: &str) -> Result<ThemeWorkspace, AppError> {
    // Reading the theme first makes an unknown id a 404 before anything is
    // written, and gives the project the name the user recognizes.
    let theme = super::store::get(theme_id).await?;
    let dir = paths::theme_dir(theme_id)?;
    let cwd = dir.to_string_lossy().to_string();
    let label = theme_label(&theme).unwrap_or_else(|| theme_id.to_string());

    let folder = authored_folder(theme_id, &cwd);
    let existing_project = folder.find_project(pool).await?;
    ensure_repository(&dir).await?;
    // After the repository, so the first commit is the theme alone. The agent
    // that is about to work here has only this folder to go on, and `theme.json`
    // does not explain itself — see `scaffold`.
    scaffold::refresh(&dir).await?;
    let name = project_name(Some(&label), theme_id);
    let project_id = folder.ensure_project(pool, existing_project, &name).await?;
    // Not only at creation: the theme may have been renamed while nothing was
    // watching — by the user's own editor, or before this ran at all.
    rename_project(pool, project_id, &name).await?;
    let (feature_id, created) =
        authoring_workspace::ensure_conversation(pool, project_id, &label).await?;
    // Asserted on every open, not only at creation. These two settings are what
    // keep the agent editing the live theme, and a failure between creating the
    // project and writing them would otherwise leave them missing for good —
    // the next conversation started here would get a worktree and repaint
    // nothing.
    authoring_workspace::apply_worktree_skip(pool, project_id, feature_id).await?;
    Ok(ThemeWorkspace {
        project_id,
        feature_id,
        cwd,
        created,
    })
}

/// Rename theme projects for as long as the service runs.
///
/// Renaming a theme is editing one string in a file, which an agent does without
/// telling anyone. Riding the watcher's event means the sidebar follows the same
/// write that repaints the app.
///
/// A rename re-broadcasts the event it just handled, which is what tells the
/// clients to refetch: they are subscribed to this same channel and received the
/// original notification *while* this rename was still running, so a refetch on
/// it would race the `UPDATE` and usually lose. The echo arrives after, and
/// terminates — handling it finds the name already current and sends nothing.
pub async fn watch_renames(
    pool: SqlitePool,
    mut events: broadcast::Receiver<super::ThemesChangeEvent>,
    renamed: broadcast::Sender<super::ThemesChangeEvent>,
) {
    loop {
        match events.recv().await {
            Ok(event) => match sync_project_name(&pool, &event.id).await {
                Ok(true) => {
                    let _ = renamed.send(event);
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(theme_id = %event.id, "failed to rename theme project: {e}")
                }
            },
            // A burst of saves outran the buffer; the next event still carries
            // the current label, so there is nothing to catch up on.
            Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Follow a renamed theme in the sidebar. `true` when the project was actually
/// renamed — most theme edits are colors, and leave the name alone.
///
/// The label lives in the file, so it can change without anyone calling an API —
/// an agent rewriting `theme.json` is the normal case.
pub async fn sync_project_name(pool: &SqlitePool, theme_id: &str) -> Result<bool, AppError> {
    let Ok(dir) = paths::theme_dir(theme_id) else {
        return Ok(false);
    };
    let cwd = dir.to_string_lossy().to_string();
    let Some(project_id) = authored_folder(theme_id, &cwd).find_project(pool).await? else {
        return Ok(false);
    };
    let theme = super::store::get(theme_id).await?;
    let name = project_name(theme_label(&theme).as_deref(), theme_id);
    rename_project(pool, project_id, &name).await
}

async fn rename_project(pool: &SqlitePool, project_id: i64, name: &str) -> Result<bool, AppError> {
    let current: Option<String> = sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await?;
    if current.as_deref() == Some(name) {
        return Ok(false);
    }
    // A project's settings live in a file named after the project, so the
    // document has to travel with the name — otherwise every setting on this
    // project (its provider, its model, …) is left behind in a file the app
    // will never read again. Before the rename, so a failure changes nothing.
    crate::domain::settings_store::project_rename(pool, project_id, name).await?;
    sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
        .bind(name)
        .bind(project_id)
        .execute(pool)
        .await?;
    // The document may have stayed put — it can already belong to a project of
    // the new name. Re-assert what a theme project cannot work without.
    authoring_workspace::apply_project_worktree_skip(pool, project_id).await?;
    Ok(true)
}

/// Drop the project for a deleted theme.
///
/// Runs *before* the theme folder is trashed, and reports its failures rather
/// than logging them: a project left pointing at a folder that is no longer
/// there is exactly the state the user would need to be told about. Failing
/// here leaves the theme itself untouched, so the delete can simply be retried.
pub async fn remove(pool: &SqlitePool, theme_id: &str) -> Result<(), AppError> {
    let dir = paths::theme_dir(theme_id)?;
    let cwd = dir.to_string_lossy().to_string();
    let Some(project_id) = authored_folder(theme_id, &cwd).find_project(pool).await? else {
        return Ok(());
    };
    // Leases its custom tabs may hold go at their next renewal, refused once
    // the conversation is gone.
    crate::domain::projects::repository::delete_project(pool, project_id)
        .await
        .map(drop)
}

fn theme_label(theme: &super::models::UserTheme) -> Option<String> {
    theme
        .theme
        .as_ref()
        .map(|document| document.label.clone())
        .or_else(|| theme.label.clone())
}

/// The sidebar name for a theme's project: `Theme: <label>` (see
/// [`authoring_workspace::prefixed_name`] for why it is prefixed). The prefix
/// also answers, in the one line the sidebar shows, why this project exists.
fn project_name(label: Option<&str>, theme_id: &str) -> String {
    authoring_workspace::prefixed_name("Theme", label, theme_id)
}

/// Make the theme directory a repository, once. A theme project without git
/// would be the one project in the app with no answer to "what did the agent
/// just do to my colors, and how do I put it back".
async fn ensure_repository(dir: &Path) -> Result<(), AppError> {
    if dir.join(".git").exists() {
        return Ok(());
    }
    std::fs::write(dir.join(".gitignore"), GITIGNORE)
        .map_err(|e| AppError::internal(format!("failed to write the theme's .gitignore: {e}")))?;
    ensure_repository_with_initial_commit(dir, COMMIT_EMAIL, "New theme").await
}

/// The theme folder as an authored project. Legacy `kind = 'theme'` rows at
/// the folder still count as its project.
fn authored_folder<'a>(theme_id: &'a str, cwd: &'a str) -> AuthoredFolder<'a> {
    AuthoredFolder {
        target: ProjectAuthoringTarget::Theme,
        plugin_id: theme_id,
        cwd,
        legacy_kind: Some(THEME_PROJECT_KIND),
        conflict: project_conflict,
    }
}

fn project_conflict(theme_id: &str, reason: &str) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "THEME_PROJECT_OWNERSHIP_CONFLICT",
        format!("cannot open theme `{theme_id}` because {reason}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::themes::test_support::{dracula_css_vars, dracula_xterm};
    use crate::shared::git_cli::run_git;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }

    async fn create_theme(label: &str) -> String {
        super::super::store::create()
            .label(label)
            .appearance(super::super::models::ThemeAppearance::Dark)
            .css_vars(dracula_css_vars())
            .xterm(dracula_xterm())
            .call()
            .await
            .expect("creates")
            .id
    }

    /// Retitle the theme the way anything outside the API does it: by editing
    /// the file.
    fn rename_theme_file(id: &str, label: &str) {
        let file = paths::theme_dir(id)
            .expect("path")
            .join(paths::THEME_FILE_NAME);
        let renamed = std::fs::read_to_string(&file)
            .expect("read")
            .replace("\"My Theme\"", &format!("\"{label}\""));
        std::fs::write(&file, renamed).expect("write");
    }

    async fn project_name_of(pool: &SqlitePool, project_id: i64) -> String {
        sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_one(pool)
            .await
            .expect("name")
    }

    async fn project_identity_of(
        pool: &SqlitePool,
        project_id: i64,
    ) -> (String, Option<String>, Option<String>) {
        sqlx::query_as("SELECT kind, authoring_target, plugin_id FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_one(pool)
            .await
            .expect("identity")
    }

    #[tokio::test]
    async fn creates_a_project_rooted_in_the_theme_folder() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        assert!(
            workspace.cwd.ends_with("themes/my-theme"),
            "{}",
            workspace.cwd
        );
        assert_eq!(
            project_name_of(&pool, workspace.project_id).await,
            "Theme: My Theme"
        );
        assert_eq!(
            project_identity_of(&pool, workspace.project_id).await,
            (
                "user".to_string(),
                Some("theme".to_string()),
                Some("my-theme".to_string())
            )
        );

        // Both, not either: the feature setting governs this conversation, and
        // the project default governs the next one the user starts here.
        let feature_mode: String = sqlx::query_scalar(
            "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_mode'",
        )
        .bind(workspace.feature_id)
        .fetch_one(&pool)
        .await
        .expect("feature worktree_mode");
        let project_mode = crate::domain::settings_store::project_get(
            &pool,
            workspace.project_id,
            "default_worktree_mode",
        )
        .await
        .expect("project settings");
        assert_eq!(
            (feature_mode.as_str(), project_mode.as_deref()),
            ("skip", Some("skip")),
            "a worktree would hide the edits from the running app"
        );
    }

    #[tokio::test]
    async fn numeric_leading_theme_ids_are_valid_authoring_identity() {
        let pool = pool().await;
        let id = create_theme("2026 Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures numeric id");

        assert_eq!(id, "2026-theme");
        assert_eq!(
            project_identity_of(&pool, workspace.project_id).await,
            (
                "user".to_string(),
                Some("theme".to_string()),
                Some("2026-theme".to_string())
            )
        );
    }

    #[tokio::test]
    async fn the_theme_folder_is_a_repository_with_the_theme_committed() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        let dir = Path::new(&workspace.cwd);

        let tracked = run_git(&["ls-files"], dir).await.expect("ls-files");
        assert!(tracked.contains("theme.json"), "{tracked}");
        // Nothing pending right after creation: the Git tab has to mean "what
        // changed since you started", not "everything".
        let status = run_git(&["status", "--porcelain"], dir)
            .await
            .expect("status");
        assert_eq!(status.trim(), "", "unexpected pending changes");
    }

    /// The agent that opens this folder has nothing but the folder. Both
    /// reference files have to be in it — and out of the user's git, or every
    /// theme's first Git tab opens on two files they didn't write.
    #[tokio::test]
    async fn the_reference_and_schema_are_there_and_invisible_to_git() {
        use crate::domain::themes::scaffold::REFERENCE_FILE_NAME;
        use crate::domain::themes::schema::SCHEMA_FILE_NAME;

        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        let dir = Path::new(&workspace.cwd);

        assert!(dir.join(REFERENCE_FILE_NAME).exists());
        assert!(dir.join(SCHEMA_FILE_NAME).exists());
        let status = run_git(&["status", "--porcelain", "--untracked-files=all"], dir)
            .await
            .expect("status");
        assert_eq!(
            status.trim(),
            "",
            "the reference files must not be git's business"
        );
    }

    /// A theme made before the reference existed gets it on the next open —
    /// which is the only reason `ensure` refreshes rather than seeding once.
    #[tokio::test]
    async fn reopening_restores_a_reference_that_was_deleted() {
        use crate::domain::themes::scaffold::REFERENCE_FILE_NAME;

        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        let reference = Path::new(&workspace.cwd).join(REFERENCE_FILE_NAME);
        std::fs::remove_file(&reference).expect("removes");

        ensure(&pool, &id).await.expect("ensures again");

        assert!(reference.exists());
    }

    #[tokio::test]
    async fn reopening_a_theme_resumes_the_same_conversation() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let first = ensure(&pool, &id).await.expect("ensures");
        let second = ensure(&pool, &id).await.expect("ensures again");
        assert_eq!(first.feature_id, second.feature_id);
        assert_eq!(first.project_id, second.project_id);
    }

    #[tokio::test]
    async fn legacy_theme_projects_remain_legacy_when_reopened() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let cwd = paths::theme_dir(&id).unwrap().to_string_lossy().to_string();
        let project_id: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path, kind) VALUES ('Legacy', ?, 'theme') RETURNING id",
        )
        .bind(&cwd)
        .fetch_one(&pool)
        .await
        .unwrap();

        let workspace = ensure(&pool, &id).await.expect("opens legacy project");

        assert_eq!(workspace.project_id, project_id);
        assert_eq!(
            project_identity_of(&pool, project_id).await,
            ("theme".to_string(), None, None)
        );
    }

    #[tokio::test]
    async fn another_projects_marker_cannot_adopt_the_theme_folder() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let cwd = paths::theme_dir(&id).unwrap().to_string_lossy().to_string();
        crate::domain::projects::service::create_author_project()
            .pool(&pool)
            .name("Other")
            .path(&cwd)
            .authoring_target(crate::domain::projects::models::ProjectAuthoringTarget::Provider)
            .plugin_id("other-provider")
            .call()
            .await
            .unwrap();

        let error = ensure(&pool, &id)
            .await
            .expect_err("ownership must conflict");
        assert!(matches!(
            error,
            AppError::Coded {
                code: "THEME_PROJECT_OWNERSHIP_CONFLICT",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn reopening_catches_up_on_a_rename_nothing_was_watching() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        rename_theme_file(&id, "Vamp");

        ensure(&pool, &id).await.expect("ensures again");

        assert_eq!(
            project_name_of(&pool, workspace.project_id).await,
            "Theme: Vamp"
        );
    }

    #[tokio::test]
    async fn the_theme_project_is_listed_like_any_other() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        let listed = crate::domain::projects::repository::list_projects(&pool)
            .await
            .expect("lists");
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].id, workspace.project_id);
    }

    #[tokio::test]
    async fn renaming_the_theme_renames_the_project() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");

        rename_theme_file(&id, "Vamp");
        let renamed = sync_project_name(&pool, &id).await.expect("syncs");

        assert!(renamed, "the caller re-broadcasts on the strength of this");
        assert_eq!(
            project_name_of(&pool, workspace.project_id).await,
            "Theme: Vamp"
        );
        // The settings file is named after the project, so the rename left the
        // old one behind — the defaults have to come with it.
        let mode = crate::domain::settings_store::project_get(
            &pool,
            workspace.project_id,
            "default_worktree_mode",
        )
        .await
        .expect("project settings");
        assert_eq!(mode.as_deref(), Some("skip"));
    }

    #[tokio::test]
    async fn an_edit_that_leaves_the_label_alone_renames_nothing() {
        // What keeps the re-broadcast from looping: the echo is handled like
        // any other event, finds the name already current, and says so — which
        // is also the common case, since most theme edits are colors.
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        ensure(&pool, &id).await.expect("ensures");

        let renamed = sync_project_name(&pool, &id).await.expect("syncs");

        assert!(!renamed);
    }

    #[tokio::test]
    async fn renaming_the_theme_keeps_the_settings_made_on_its_project() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        crate::domain::settings_store::project_set(
            &pool,
            workspace.project_id,
            "model_session",
            "claude-opus-5",
        )
        .await
        .expect("sets a project setting");

        rename_theme_file(&id, "Vamp");
        sync_project_name(&pool, &id).await.expect("syncs");

        // The settings document is named after the project, so without moving
        // it every choice made here would be stranded in the old file.
        let model = crate::domain::settings_store::project_get(
            &pool,
            workspace.project_id,
            "model_session",
        )
        .await
        .expect("project settings");
        assert_eq!(model.as_deref(), Some("claude-opus-5"));
    }

    #[tokio::test]
    async fn reopening_restores_settings_a_failed_first_open_never_wrote() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        // Stand in for a failure between creating the project and configuring
        // it: without them the next conversation started here gets a worktree
        // and the running app repaints from a file nobody is editing.
        sqlx::query("DELETE FROM feature_settings WHERE feature_id = ?")
            .bind(workspace.feature_id)
            .execute(&pool)
            .await
            .expect("clears");
        crate::domain::settings_store::project_set(
            &pool,
            workspace.project_id,
            "default_worktree_mode",
            "worktree",
        )
        .await
        .expect("clears");

        ensure(&pool, &id).await.expect("ensures again");

        let feature_mode: Option<String> = sqlx::query_scalar(
            "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_mode'",
        )
        .bind(workspace.feature_id)
        .fetch_optional(&pool)
        .await
        .expect("feature worktree_mode");
        let project_mode = crate::domain::settings_store::project_get(
            &pool,
            workspace.project_id,
            "default_worktree_mode",
        )
        .await
        .expect("project settings");
        assert_eq!(
            (feature_mode.as_deref(), project_mode.as_deref()),
            (Some("skip"), Some("skip"))
        );
    }

    #[tokio::test]
    async fn only_the_first_open_arranges_the_panes() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        assert!(ensure(&pool, &id).await.expect("ensures").created);
        assert!(
            !ensure(&pool, &id).await.expect("ensures again").created,
            "a layout the user rearranged is theirs to keep"
        );
    }

    #[tokio::test]
    async fn deleting_a_theme_takes_its_project_with_it() {
        let pool = pool().await;
        let id = create_theme("My Theme").await;
        let workspace = ensure(&pool, &id).await.expect("ensures");
        remove(&pool, &id).await.expect("removes");

        let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE id = ?")
            .bind(workspace.project_id)
            .fetch_one(&pool)
            .await
            .expect("counts");
        let features: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM features WHERE id = ?")
            .bind(workspace.feature_id)
            .fetch_one(&pool)
            .await
            .expect("counts");
        assert_eq!((projects, features), (0, 0));
    }

    #[tokio::test]
    async fn an_unknown_theme_has_no_project() {
        let pool = pool().await;
        assert!(ensure(&pool, "nope").await.is_err());
    }

    #[test]
    fn a_label_a_project_cannot_be_named_falls_back_to_the_slug() {
        assert_eq!(project_name(Some("  Vamp  "), "vamp"), "Theme: Vamp");
        for label in ["", "   ", "a/b", "../evil"] {
            let named = project_name(Some(label), "my-theme");
            assert_eq!(named, "Theme: my-theme", "{label}");
        }
        assert_eq!(project_name(None, "my-theme"), "Theme: my-theme");
    }
}
