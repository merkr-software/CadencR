use crate::domain::ws_session::runtime::output::OutputTarget;
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::feature_events::{FeatureEventAction, FeatureEventBroadcaster};
use crate::domain::workflow::worktree;
use crate::domain::ws_session::permissions;
use crate::domain::ws_session::protocol::PromptSendPayload;

use super::super::{SessionConfig, WsSender};

/// First-prompt branch provisioning. Two mutually-exclusive paths, both of
/// which auto-name the feature *first* so the branch name reflects the prompt:
///
///   - `use_worktree` → auto-name, then `ensure_worktree` (worktree subsystem).
///   - `new_project_branch` → auto-name, then fork a project-path branch named
///     after the feature (no worktree, no setup) — the "From branch" flow.
///
/// Returns `Ok(true)` when auto-naming was performed synchronously (so the
/// async fallback in `spawn_auto_name_if_needed` is skipped), `Ok(false)` when
/// neither path applies. Both paths return `Err` to abort the prompt with a
/// user-visible message: a failed `git checkout -b` (project-branch path) or a
/// failed worktree provisioning (worktree path) must never let the agent run in
/// the project root on the project branch instead of the requested worktree.
pub(in crate::domain::ws_session) async fn prepare_branch_provisioning(
    app_state: &AppState,
    write_pool: &sqlx::SqlitePool,
    sender: &impl OutputTarget,
    payload: &PromptSendPayload,
    feature_id: i64,
    config: &mut SessionConfig,
    options: &mut RuntimeSpawnConfig,
) -> Result<bool, String> {
    // A worktree chosen on an earlier prompt whose provisioning failed is
    // provisioned now: the project root is never a substitute for it.
    let use_worktree = payload.use_worktree.unwrap_or(false)
        || worktree::provisioning_unfinished(&app_state.read_pool, feature_id)
            .await
            .map_err(|e| e.to_string())?;
    let new_project_branch = payload.new_project_branch.as_ref();
    if !use_worktree && new_project_branch.is_none() {
        return Ok(false);
    }

    let progress_sender = app_state
        .ws_feature_senders
        .feature_output_sender(feature_id, sender);
    // Both provisioning paths auto-name the feature first, so the branch/worktree
    // created right after carries a prompt-derived name.
    auto_name_first_prompt(
        write_pool,
        &app_state.feature_events_tx,
        &progress_sender,
        payload,
        feature_id,
        config,
    )
    .await;

    if use_worktree {
        // Worktree creation + setup progress must reach every device viewing
        // the feature, so create/apply against a fan-out sender rather than the
        // lone initiator socket.
        create_and_apply_worktree(
            app_state,
            write_pool,
            &progress_sender,
            feature_id,
            config,
            options,
        )
        .await?;
    } else if let Some(branch) = new_project_branch {
        create_project_branch_for_feature(
            app_state,
            write_pool,
            feature_id,
            branch.base.as_deref(),
        )
        .await?;
    }
    Ok(true)
}

/// "From branch" project-path flow: fork a new branch named after the
/// (now auto-named) feature in the project folder. No worktree is involved, so
/// the agent's cwd stays the project dir and nothing else changes — the git
/// status watcher picks up the moved HEAD just like any agent-driven branch
/// switch. `create_project_branch` derives the name from the feature title,
/// records it as `feature_branch`, and persists no `worktree_*` settings, so
/// the feature stays bound to its branch without being treated as having a
/// worktree.
async fn create_project_branch_for_feature(
    app_state: &AppState,
    write_pool: &sqlx::SqlitePool,
    feature_id: i64,
    base: Option<&str>,
) -> Result<(), String> {
    let project_id = worktree::get_project_id_for_feature(&app_state.read_pool, feature_id).await?;
    let branch = worktree::create_project_branch(
        &app_state.read_pool,
        write_pool,
        feature_id,
        project_id,
        base,
    )
    .await?;
    info!(feature_id, %branch, "created project-path branch for 'from branch' prompt");
    Ok(())
}

pub(in crate::domain::ws_session) fn spawn_auto_name_if_needed(
    auto_name_handled: bool,
    write_pool: sqlx::SqlitePool,
    feature_events: FeatureEventBroadcaster,
    sender: WsSender,
    feature_id: i64,
    prompt_text: String,
    cwd: String,
) {
    // The branch-provisioning paths already auto-named synchronously; only the
    // plain (no worktree, no new branch) path needs the async fallback.
    if auto_name_handled {
        return;
    }
    tokio::spawn(async move {
        match super::super::super::auto_name::has_default_title(&write_pool, feature_id).await {
            Ok(true) => {
                let result = super::super::super::auto_name::auto_name_feature(
                    write_pool,
                    feature_id,
                    prompt_text,
                    cwd,
                    sender,
                )
                .await;
                // The live `feature.renamed` envelope only reached devices with
                // this conversation open; broadcast a global feature_event so
                // every connected client's sidebar (and any open header)
                // refetches the new title.
                if result.is_some() {
                    feature_events.emit(feature_id, None, FeatureEventAction::Updated);
                }
                info!(feature_id, name = ?result, "auto-named feature");
            }
            Ok(false) => {}
            Err(error) => warn!(feature_id, %error, "auto-name: failed to check title"),
        }
    });
}

/// Synchronously auto-name the feature from the first prompt, so a branch/
/// worktree created right after carries a meaningful, prompt-derived name.
/// No-op when the title is already user-set (`has_default_title` → false).
async fn auto_name_first_prompt(
    write_pool: &sqlx::SqlitePool,
    feature_events: &FeatureEventBroadcaster,
    sender: &WsSender,
    payload: &PromptSendPayload,
    feature_id: i64,
    config: &SessionConfig,
) {
    match super::super::super::auto_name::has_default_title(write_pool, feature_id).await {
        Ok(true) => {
            let result = super::super::super::auto_name::auto_name_feature(
                write_pool.clone(),
                feature_id,
                payload.text.clone(),
                config.cwd.to_string_lossy().to_string(),
                sender.clone(),
            )
            .await;
            if result.is_some() {
                feature_events.emit(feature_id, None, FeatureEventAction::Updated);
            }
            info!(feature_id, name = ?result, "auto-named feature before branch setup");
        }
        Ok(false) => {}
        Err(error) => warn!(feature_id, %error, "auto-name: failed to check title"),
    }
}

async fn create_and_apply_worktree(
    app_state: &AppState,
    write_pool: &sqlx::SqlitePool,
    sender: &WsSender,
    feature_id: i64,
    config: &mut SessionConfig,
    options: &mut RuntimeSpawnConfig,
) -> Result<(), String> {
    let project_id = worktree::get_project_id_for_feature(&app_state.read_pool, feature_id).await?;
    apply_worktree_for_project(
        app_state, write_pool, sender, feature_id, project_id, config, options,
    )
    .await
}

async fn apply_worktree_for_project(
    app_state: &AppState,
    write_pool: &sqlx::SqlitePool,
    sender: &WsSender,
    feature_id: i64,
    project_id: i64,
    config: &mut SessionConfig,
    options: &mut RuntimeSpawnConfig,
) -> Result<(), String> {
    // A worktree was explicitly requested. If provisioning fails, abort the
    // prompt with a surfaced error rather than silently running the agent in the
    // project root on the project branch — that degradation is the bug we're
    // fixing, and editing the project checkout unexpectedly is never safe.
    let worktree_path = worktree::ensure_worktree(
        &app_state.read_pool,
        write_pool,
        &app_state.worktree_setup_runs,
        feature_id,
        project_id,
        sender,
    )
    .await?;
    info!(feature_id, path = %worktree_path.display(), "worktree created for session");
    maybe_spawn_setup_commands(app_state, write_pool, sender, feature_id, &worktree_path).await?;
    options.cwd = worktree_path.clone();
    config.canonical_cwd = permissions::canonicalize_worktree(&worktree_path);
    config.cwd = worktree_path;
    Ok(())
}

async fn maybe_spawn_setup_commands(
    app_state: &AppState,
    write_pool: &sqlx::SqlitePool,
    sender: &WsSender,
    feature_id: i64,
    worktree_path: &std::path::Path,
) -> Result<(), String> {
    if app_state.worktree_setup_runs.is_owned(feature_id) {
        return Ok(());
    }
    let setup_step = worktree::get_setting(&app_state.read_pool, feature_id, "worktree_setup_step")
        .await
        .map_err(|e| e.to_string())?;
    if setup_step.as_deref() == Some("ready") {
        return Ok(());
    }
    let read_pool = app_state.read_pool.clone();
    let write_pool = write_pool.clone();
    let setup_runs = app_state.worktree_setup_runs.clone();
    let sender = sender.clone();
    let worktree_path = worktree_path.to_path_buf();
    tokio::spawn(async move {
        worktree::run_setup_commands(
            read_pool,
            write_pool,
            setup_runs,
            feature_id,
            worktree_path,
            sender,
        )
        .await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::make_active_handle;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    /// After a failed first prompt, the next one no longer carries
    /// `use_worktree`. It used to skip provisioning and run the agent in the
    /// project root; the chosen worktree is provisioned again instead, and a
    /// provisioning that fails again stops the prompt.
    #[tokio::test]
    async fn a_chosen_worktree_left_unprovisioned_is_never_replaced_by_the_project_root() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        let state = AppState::with_pool(pool.clone());
        // Not a git repository: attaching the reused branch fails.
        let project = tempfile::tempdir().unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'QA', ?)")
            .bind(project.path().to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'Shared')")
            .execute(&pool)
            .await
            .unwrap();
        for (key, value) in [
            ("worktree_mode", "reuse"),
            ("worktree_reuse_branch", "feat/donor"),
        ] {
            worktree::set_setting(&pool, 1, key, value).await.unwrap();
        }
        let payload: PromptSendPayload =
            serde_json::from_value(serde_json::json!({"session_id": "1", "text": "pwd"})).unwrap();
        let mut config = make_active_handle(1, None).config;
        let mut options = RuntimeSpawnConfig::default();
        let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();

        let provisioned = prepare_branch_provisioning(
            &state,
            &pool,
            &sender,
            &payload,
            1,
            &mut config,
            &mut options,
        )
        .await;

        assert!(provisioned.is_err(), "{provisioned:?}");
        assert_ne!(options.cwd, project.path());
    }
}
