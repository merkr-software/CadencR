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

use std::path::PathBuf;

use sqlx::SqlitePool;

use super::envelope::send_envelope;
use super::get_setting;
use crate::domain::workflow::ws_sender::WsSender;

/// Re-emit the feature's persisted worktree state to `sender`, reusing the exact
/// envelopes the frontend's worktree state machine already handles. Returns the
/// worktree path when a usable worktree exists on disk, or `None` (emitting
/// nothing) when there is no worktree recorded or its directory is gone — the
/// prompt-time caller treats `None` as "fall through to provisioning".
pub async fn replay_persisted_state(
    read_pool: &SqlitePool,
    feature_id: i64,
    sender: &WsSender,
) -> Option<PathBuf> {
    let path = get_setting(read_pool, feature_id, "worktree_path").await?;
    if path.is_empty() || tokio::fs::metadata(&path).await.is_err() {
        return None;
    }
    let branch = get_setting(read_pool, feature_id, "worktree_branch").await;
    send_envelope(
        sender,
        "workflow",
        "worktree.created",
        serde_json::json!({ "feature_id": feature_id, "path": path, "branch": branch }),
    );

    let step = get_setting(read_pool, feature_id, "worktree_setup_step")
        .await
        .unwrap_or_else(|| "created".to_string());
    match step.as_str() {
        "ready" => replay_ready(read_pool, feature_id, sender).await,
        "setup_error" => replay_setup_error(read_pool, feature_id, sender).await,
        "setup_running" => replay_setup_running(read_pool, feature_id, sender).await,
        _ => {}
    }
    Some(PathBuf::from(path))
}

async fn replay_ready(read_pool: &SqlitePool, feature_id: i64, sender: &WsSender) {
    replay_setup_output(read_pool, feature_id, sender).await;
    send_envelope(
        sender,
        "workflow",
        "worktree.ready",
        serde_json::json!({ "feature_id": feature_id }),
    );
}

async fn replay_setup_error(read_pool: &SqlitePool, feature_id: i64, sender: &WsSender) {
    let error = get_setting(read_pool, feature_id, "worktree_setup_error")
        .await
        .unwrap_or_default();
    let output = get_setting(read_pool, feature_id, "worktree_setup_log")
        .await
        .unwrap_or_default();
    send_envelope(
        sender,
        "workflow",
        "worktree.setup_error",
        serde_json::json!({ "feature_id": feature_id, "error": error, "output": output }),
    );
}

async fn replay_setup_running(read_pool: &SqlitePool, feature_id: i64, sender: &WsSender) {
    send_envelope(
        sender,
        "workflow",
        "worktree.setup_running",
        serde_json::json!({ "feature_id": feature_id }),
    );
    // `worktree_setup_log` is only flushed to the DB on completion, so mid-run
    // there is usually nothing to replay; the live mirror feeds new lines from
    // here on. Replay whatever is persisted just in case.
    replay_setup_output(read_pool, feature_id, sender).await;
}

async fn replay_setup_output(read_pool: &SqlitePool, feature_id: i64, sender: &WsSender) {
    if let Some(log) = get_setting(read_pool, feature_id, "worktree_setup_log").await {
        for line in log.lines() {
            send_envelope(
                sender,
                "workflow",
                "worktree.setup_output",
                serde_json::json!({ "feature_id": feature_id, "line": line }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::replay_persisted_state;
    use crate::domain::workflow::worktree::set_setting;
    use axum::extract::ws::Message;
    use sqlx::SqlitePool;
    use tokio::sync::mpsc;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, \
             PRIMARY KEY (feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn actions(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(Message::Text(text)) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            out.push(v["action"].as_str().unwrap().to_string());
        }
        out
    }

    #[tokio::test]
    async fn no_worktree_emits_nothing_and_returns_none() {
        let pool = test_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert!(replay_persisted_state(&pool, 1, &tx).await.is_none());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn ready_worktree_replays_created_output_and_ready() {
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
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

        assert!(replay_persisted_state(&pool, 1, &tx).await.is_some());

        assert_eq!(
            actions(&mut rx),
            vec![
                "worktree.created",
                "worktree.setup_output",
                "worktree.setup_output",
                "worktree.ready"
            ]
        );
    }

    #[tokio::test]
    async fn missing_worktree_dir_is_skipped() {
        let pool = test_pool().await;
        set_setting(&pool, 1, "worktree_path", "/no/such/path-xyz")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "ready")
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        // A path that no longer exists on disk must not surface a phantom worktree.
        assert!(replay_persisted_state(&pool, 1, &tx).await.is_none());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn setup_running_replays_running_then_persisted_log_lines() {
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_running")
            .await
            .unwrap();
        // No `worktree_setup_log` persisted yet — the common mid-run case.
        let (tx, mut rx) = mpsc::unbounded_channel();

        assert!(replay_persisted_state(&pool, 1, &tx).await.is_some());

        assert_eq!(
            actions(&mut rx),
            vec!["worktree.created", "worktree.setup_running"],
            "with no persisted log, only created + setup_running are replayed"
        );
    }

    #[tokio::test]
    async fn setup_error_replays_error_with_output() {
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        set_setting(&pool, 1, "worktree_path", &path).await.unwrap();
        set_setting(&pool, 1, "worktree_setup_step", "setup_error")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_setup_error", "boom")
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        assert!(replay_persisted_state(&pool, 1, &tx).await.is_some());

        assert_eq!(
            actions(&mut rx),
            vec!["worktree.created", "worktree.setup_error"]
        );
    }
}
