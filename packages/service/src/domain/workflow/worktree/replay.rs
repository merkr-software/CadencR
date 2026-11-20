//! Replay a feature's persisted worktree provisioning state to a WS client.
//!
//! The live provisioning envelopes (`worktree.creating` / `created` /
//! `setup_running` / `setup_output` / `ready` / `setup_error`) only reach
//! devices connected *while* provisioning runs. Two paths need to re-emit the
//! current state from the `feature_settings` source of truth instead:
//!
//! - `session.init` for a client that opens a conversation started elsewhere
//!   (e.g. the desktop opening a phone-started worktree), and
//! - the prompt-time worktree dispatch when a usable worktree already exists.
//!
//! Both go through [`replay_persisted_state`] so the emitted shape can never
//! drift between them.

mod reconcile;

use std::path::PathBuf;

use sqlx::SqlitePool;

use super::envelope::send_envelope;
use super::setup_events::{send_error, send_ready};
use super::{
    get_project_directory, get_project_id_for_feature, get_setting, resolve_live_worktree,
    WorktreeSetupRegistry,
};
use crate::domain::workflow::ws_sender::WsSender;

/// Re-emit the feature's persisted worktree state to `sender`, reusing the exact
/// envelopes the frontend's worktree state machine already handles. Returns the
/// worktree path when a usable worktree exists on disk, or `None` (emitting
/// nothing) when there is no worktree recorded or its directory is gone — the
/// prompt-time caller treats `None` as "fall through to provisioning".
pub async fn replay_persisted_state(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    setup_runs: &WorktreeSetupRegistry,
    feature_id: i64,
    sender: &WsSender,
) -> Result<Option<PathBuf>, String> {
    let project_id = get_project_id_for_feature(read_pool, feature_id).await?;
    let project_path = get_project_directory(read_pool, project_id).await?;
    let Some(path) = resolve_live_worktree(read_pool, feature_id, &project_path).await? else {
        return Ok(None);
    };
    let branch = get_setting(read_pool, feature_id, "worktree_branch")
        .await
        .map_err(|e| e.to_string())?;
    send_envelope(
        sender,
        "workflow",
        "worktree.created",
        serde_json::json!({ "feature_id": feature_id, "path": path, "branch": branch }),
    );

    let step = get_setting(read_pool, feature_id, "worktree_setup_step")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "created".to_string());
    match step.as_str() {
        "ready" => replay_ready(read_pool, feature_id, sender).await?,
        "setup_error" => replay_setup_error(read_pool, feature_id, sender).await?,
        "setup_running" => {
            reconcile::replay_or_reconcile_setup(
                read_pool, write_pool, setup_runs, feature_id, sender,
            )
            .await?
        }
        _ => {}
    }
    Ok(Some(PathBuf::from(path)))
}

async fn replay_ready(
    read_pool: &SqlitePool,
    feature_id: i64,
    sender: &WsSender,
) -> Result<(), String> {
    let log = setup_log(read_pool, feature_id).await?;
    send_ready(feature_id, sender, &log);
    Ok(())
}

async fn replay_setup_error(
    read_pool: &SqlitePool,
    feature_id: i64,
    sender: &WsSender,
) -> Result<(), String> {
    let error = get_setting(read_pool, feature_id, "worktree_setup_error")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let log = setup_log(read_pool, feature_id).await?;
    send_error(feature_id, sender, &error, &log);
    Ok(())
}

async fn setup_log(read_pool: &SqlitePool, feature_id: i64) -> Result<String, String> {
    Ok(get_setting(read_pool, feature_id, "worktree_setup_log")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default())
}

#[cfg(test)]
async fn test_pool(project_path: &str) -> SqlitePool {
    static NEXT_PROJECT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    for statement in [
        "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (feature_id, key))",
        "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
        "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    let project_name = format!(
        "replay-test-{}",
        NEXT_PROJECT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, ?, ?)")
        .bind(project_name)
        .bind(project_path)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (id, project_id) VALUES (1, 1)")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::{replay_persisted_state, test_pool};
    use crate::domain::workflow::worktree::{set_setting, WorktreeSetupRegistry};
    use axum::extract::ws::Message;
    use tokio::sync::mpsc;

    async fn git_project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init"], dir.path())
            .await
            .unwrap();
        dir
    }

    fn envelopes(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(Message::Text(text)) = rx.try_recv() {
            out.push(serde_json::from_str(&text).unwrap());
        }
        out
    }

    fn actions(envelopes: &[serde_json::Value]) -> Vec<String> {
        envelopes
            .iter()
            .map(|value| value["action"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn no_worktree_emits_nothing_and_returns_none() {
        let pool = test_pool("/project").await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let setup_runs = WorktreeSetupRegistry::new();
        assert!(replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap()
            .is_none());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn ready_worktree_replays_created_output_and_ready() {
        let dir = git_project().await;
        let pool = test_pool(&dir.path().to_string_lossy()).await;
        let path = dir.path().to_string_lossy().to_string();
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_branch", "feat/x")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "ready")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_log", "$ pnpm install\nDone")
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let setup_runs = WorktreeSetupRegistry::new();
        assert!(replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap()
            .is_some());

        let envelopes = envelopes(&mut rx);
        assert_eq!(
            actions(&envelopes),
            vec![
                "worktree.created",
                "worktree.setup_output",
                "worktree.ready"
            ]
        );
        let snapshot = &envelopes[1]["payload"];
        assert_eq!(snapshot["line"], "$ pnpm install\nDone");
        assert_eq!(snapshot["replace"], true);
    }

    #[tokio::test]
    async fn missing_worktree_dir_is_skipped() {
        let pool = test_pool("/project").await;
        set_setting(&pool, 1, "worktree_path", "/no/such/path-xyz")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "ready")
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        // A path that no longer exists on disk must not surface a phantom worktree.
        let setup_runs = WorktreeSetupRegistry::new();
        assert!(replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap()
            .is_none());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn leftover_non_git_worktree_dir_is_skipped() {
        let project = git_project().await;
        let pool = test_pool(&project.path().to_string_lossy()).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "ready")
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let setup_runs = WorktreeSetupRegistry::new();
        assert!(replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap()
            .is_none());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn setup_running_replays_running_then_persisted_log_lines() {
        let dir = git_project().await;
        let pool = test_pool(&dir.path().to_string_lossy()).await;
        let path = dir.path().to_string_lossy().to_string();
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_running")
            .await
            .unwrap();
        // No `worktree_setup_log` persisted yet — the common mid-run case.
        let setup_runs = WorktreeSetupRegistry::new();
        let _permit = setup_runs.try_acquire(1).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        assert!(replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap()
            .is_some());

        assert_eq!(
            actions(&envelopes(&mut rx)),
            vec!["worktree.created", "worktree.setup_running"],
            "with no persisted log, only created + setup_running are replayed"
        );
    }

    #[tokio::test]
    async fn setup_error_replays_error_with_output() {
        let dir = git_project().await;
        let pool = test_pool(&dir.path().to_string_lossy()).await;
        let path = dir.path().to_string_lossy().to_string();
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_error")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_error", "boom")
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let setup_runs = WorktreeSetupRegistry::new();
        assert!(replay_persisted_state(&pool, &pool, &setup_runs, 1, &tx)
            .await
            .unwrap()
            .is_some());

        assert_eq!(
            actions(&envelopes(&mut rx)),
            vec!["worktree.created", "worktree.setup_error"]
        );
    }
}
