//! Recovery for persisted setup work whose process no longer exists.

use sqlx::SqlitePool;

use super::super::setup_events::{send_error, send_output_snapshot, send_ready, send_running};
use super::super::setup_finish::{finish_error, finish_ready};
use super::super::WorktreeSetupRegistry;
use crate::domain::workflow::worktree::get_setting;
use crate::domain::workflow::worktree::setup::resolve_setup_commands;
use crate::domain::workflow::ws_sender::WsSender;

/// Replay an active run under the same lock used to publish terminal events, or
/// claim and reconcile an orphaned persisted run. This ordering prevents a stale
/// `setup_running` replay from overtaking `ready` or `setup_error`.
pub(super) async fn replay_or_reconcile_setup(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    setup_runs: &WorktreeSetupRegistry,
    feature_id: i64,
    sender: &WsSender,
) -> Result<(), String> {
    loop {
        let log = super::setup_log(read_pool, feature_id).await?;
        if setup_runs
            .if_active(feature_id, || {
                send_running(feature_id, sender);
                send_output_snapshot(feature_id, sender, &log);
            })
            .is_some()
        {
            return Ok(());
        }

        let Some(permit) = setup_runs.try_acquire_recovery(feature_id) else {
            tokio::task::yield_now().await;
            continue;
        };
        return reconcile_claimed_setup(read_pool, write_pool, feature_id, sender, permit).await;
    }
}

async fn reconcile_claimed_setup(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    feature_id: i64,
    sender: &WsSender,
    permit: crate::domain::features::run_registry::FeatureRunPermit,
) -> Result<(), String> {
    let refreshed_step = get_setting(read_pool, feature_id, "worktree_setup_step")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "created".to_string());
    if refreshed_step == "ready" {
        let log = super::setup_log(read_pool, feature_id).await?;
        permit.finish(|| send_ready(feature_id, sender, &log));
        return Ok(());
    }
    if refreshed_step == "setup_error" {
        let error = get_setting(read_pool, feature_id, "worktree_setup_error")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let log = super::setup_log(read_pool, feature_id).await?;
        permit.finish(|| send_error(feature_id, sender, &error, &log));
        return Ok(());
    }
    if refreshed_step != "setup_running" {
        return Ok(());
    }

    let log = super::setup_log(read_pool, feature_id).await?;
    match resolve_setup_commands(read_pool, feature_id).await {
        Ok(None) => finish_ready(write_pool, feature_id, sender, permit, &log, None).await,
        Ok(Some(_)) => {
            finish_error(
                write_pool,
                feature_id,
                sender,
                Some(permit),
                "Worktree setup was interrupted before completion. Retry setup to run the configured commands again.",
                &log,
                None,
            )
            .await;
        }
        Err(error) => {
            finish_error(
                write_pool,
                feature_id,
                sender,
                Some(permit),
                &error,
                &log,
                None,
            )
            .await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::replay_persisted_state;
    use super::super::test_pool;
    use crate::domain::workflow::worktree::{get_setting, set_setting, WorktreeSetupRegistry};
    use axum::extract::ws::Message;

    fn actions(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Message>) -> Vec<String> {
        let mut actions = Vec::new();
        while let Ok(Message::Text(text)) = rx.try_recv() {
            let envelope: serde_json::Value = serde_json::from_str(&text).unwrap();
            actions.push(envelope["action"].as_str().unwrap().to_string());
        }
        actions
    }

    #[tokio::test]
    async fn inactive_running_setup_becomes_ready_or_interrupted_from_current_commands() {
        let project = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init"], project.path())
            .await
            .unwrap();
        let path = project.path().to_string_lossy().into_owned();
        let pool = test_pool(&path).await;
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_running")
            .await
            .unwrap();
        let setup_runs = WorktreeSetupRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap();

        assert_eq!(
            get_setting(&pool, 1, "worktree_setup_step")
                .await
                .unwrap()
                .as_deref(),
            Some("ready")
        );
        assert_eq!(actions(&mut rx), vec!["worktree.created", "worktree.ready"]);

        crate::domain::settings_store::project_set(&pool, 1, "setup_worktree", "pnpm install")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_running")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_log", "partial output")
            .await
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap();

        assert_eq!(
            get_setting(&pool, 1, "worktree_setup_step")
                .await
                .unwrap()
                .as_deref(),
            Some("setup_error")
        );
        assert_eq!(
            actions(&mut rx),
            vec!["worktree.created", "worktree.setup_error"]
        );
    }

    #[tokio::test]
    async fn concurrent_replays_wait_for_one_reconciliation_result() {
        let project = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init"], project.path())
            .await
            .unwrap();
        let path = project.path().to_string_lossy().into_owned();
        let pool = test_pool(&path).await;
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_running")
            .await
            .unwrap();
        crate::domain::settings_store::project_set(&pool, 1, "setup_worktree", "pnpm install")
            .await
            .unwrap();
        let setup_runs = WorktreeSetupRegistry::new();
        let (first_tx, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
        let (second_tx, mut second_rx) = tokio::sync::mpsc::unbounded_channel();

        let (first, second) = tokio::join!(
            replay_persisted_state(&pool, &pool, &setup_runs, 1, &first_tx),
            replay_persisted_state(&pool, &pool, &setup_runs, 1, &second_tx),
        );
        first.unwrap();
        second.unwrap();

        let expected = vec!["worktree.created", "worktree.setup_error"];
        assert_eq!(actions(&mut first_rx), expected);
        assert_eq!(actions(&mut second_rx), expected);
    }
}
