use crate::domain::ws_session::runtime::output::OutputTarget;
use tracing::info;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::auto_name::auto_name_feature;
use crate::domain::ws_session::permissions;
use crate::domain::ws_session::protocol::PromptSendPayload;

use super::super::{SessionConfig, WsSender};

/// First-prompt branch provisioning. Either path can name the feature first
/// so a newly derived branch name reflects the prompt:
///
/// - `use_worktree` provisions the selected worktree.
/// - `new_project_branch` forks a branch named after the feature in the
///   project directory (the "From branch" flow).
///
/// Returns `Ok(true)` when provisioning handles naming, including when an
/// existing naming run owns it. The async fallback then skips this prompt.
/// Returns `Ok(false)` when neither path applies. Both paths return `Err`
/// with a user-visible message: a failed `git checkout -b` (project-branch path) or a
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
    // Give a new branch a prompt-derived name when the naming slot is free.
    auto_name_first_prompt(
        app_state,
        write_pool,
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
    app_state: &AppState,
    owner: &impl OutputTarget,
    feature_id: i64,
    prompt_text: String,
    cwd: String,
) {
    // Branch provisioning already made the naming decision. Only the plain
    // path (no worktree or new branch) needs the async fallback.
    if auto_name_handled {
        return;
    }
    let Some(permit) = app_state.auto_name_runs.try_acquire(feature_id) else {
        return;
    };
    let write_pool = app_state.write_pool.clone();
    let feature_events = app_state.feature_events_tx.clone();
    let sender = app_state
        .ws_feature_senders
        .feature_output_sender(feature_id, owner);
    tokio::spawn(async move {
        if auto_name_feature(&write_pool, feature_id, &prompt_text, &cwd, &sender, permit).await {
            // Refresh sidebars even on clients that aren't viewing this conversation.
            feature_events.emit(feature_id, None, FeatureEventAction::Updated);
        }
    });
}

/// Give a new branch a prompt-derived title when naming can start here.
async fn auto_name_first_prompt(
    app_state: &AppState,
    write_pool: &sqlx::SqlitePool,
    sender: &WsSender,
    payload: &PromptSendPayload,
    feature_id: i64,
    config: &SessionConfig,
) {
    // Provisioning can use the reserved branch or derive one from the current
    // title while a separate naming request finishes.
    let Some(permit) = app_state.auto_name_runs.try_acquire(feature_id) else {
        return;
    };
    if auto_name_feature(
        write_pool,
        feature_id,
        &payload.text,
        &config.cwd.to_string_lossy(),
        sender,
        permit,
    )
    .await
    {
        app_state
            .feature_events_tx
            .emit(feature_id, None, FeatureEventAction::Updated);
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
