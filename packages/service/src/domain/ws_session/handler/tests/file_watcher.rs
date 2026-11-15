//! `app.subscribe.file_watcher`: one live subscription per client, replaced
//! when the client switches feature, and independent between clients.

use super::support::*;
use std::time::Duration;

/// The debouncer (500 ms) plus FSEvents/inotify latency stays well under this.
const EVENT_TIMEOUT: Duration = Duration::from_secs(5);
/// Window after the first event in which duplicate relays would deliver.
const DUPLICATE_WINDOW: Duration = Duration::from_millis(1500);

async fn point_project_at(state: &AppState, project_id: i64, path: &std::path::Path) {
    sqlx::query("INSERT OR REPLACE INTO projects (id, name, path) VALUES (?, 'P', ?)")
        .bind(project_id)
        .bind(path.to_string_lossy().to_string())
        .execute(&state.write_pool)
        .await
        .unwrap();
}

async fn subscribe(
    tx: &WsSender,
    rx: &mut mpsc::UnboundedReceiver<Message>,
    state: &AppState,
    project_id: i64,
    feature_id: i64,
) {
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let envelope = make_envelope(
        "app",
        "subscribe.file_watcher",
        serde_json::json!({ "project_id": project_id, "feature_id": feature_id }),
    );
    dispatch_envelope(envelope, tx, &sdk_sessions, state).await;
    let ack = tokio::time::timeout(EVENT_TIMEOUT, rx.recv())
        .await
        .unwrap()
        .unwrap();
    let Message::Text(text) = ack else {
        panic!("expected text ack");
    };
    let env: WsEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(env.action, "file_watcher.subscribed", "{text}");
}

/// Let the OS watch settle, then discard whatever its start reported, so the
/// next count only covers the write that follows.
async fn settle_watch(rx: &mut mpsc::UnboundedReceiver<Message>) {
    tokio::time::sleep(Duration::from_millis(300)).await;
    while let Ok(Some(_)) = tokio::time::timeout(DUPLICATE_WINDOW, rx.recv()).await {}
}

/// Every `file_tree.changed` payload received within the window that opens
/// on the first one.
async fn collect_changes(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<Value> {
    let mut payloads = Vec::new();
    let mut deadline = tokio::time::Instant::now() + EVENT_TIMEOUT;
    while let Ok(Some(msg)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        let Message::Text(text) = msg else { continue };
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        if env.domain == "editor" && env.action == "file_tree.changed" {
            if payloads.is_empty() {
                deadline = tokio::time::Instant::now() + DUPLICATE_WINDOW;
            }
            payloads.push(env.payload);
        }
    }
    payloads
}

fn temp_root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    (dir, root)
}

#[tokio::test]
async fn switching_features_keeps_a_single_relay_per_client() {
    let state = make_test_app_state().await;
    let (_dir, root) = temp_root();
    point_project_at(&state, 1, &root).await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    for feature_id in [1, 2, 1, 2] {
        subscribe(&tx, &mut rx, &state, 1, feature_id).await;
    }
    assert_eq!(
        state.editor_watchers.counts().await,
        (1, 1),
        "one relay and one OS watcher"
    );
    settle_watch(&mut rx).await;
    std::fs::write(root.join("edited.txt"), "x").unwrap();

    let changes = collect_changes(&mut rx).await;
    assert_eq!(changes.len(), 1, "one event per change, got {changes:?}");
    assert_eq!(changes[0]["feature_id"], 2);
}

#[tokio::test]
async fn a_second_client_does_not_steal_the_first_clients_watch() {
    let state = make_test_app_state().await;
    let (_dir_a, root_a) = temp_root();
    let (_dir_b, root_b) = temp_root();
    point_project_at(&state, 1, &root_a).await;
    point_project_at(&state, 2, &root_b).await;
    sqlx::query("INSERT INTO features (id, project_id, title) VALUES (3, 2, 'Other project')")
        .execute(&state.write_pool)
        .await
        .unwrap();
    let (tx_a, mut rx_a) = mpsc::unbounded_channel();
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();

    subscribe(&tx_a, &mut rx_a, &state, 1, 1).await;
    subscribe(&tx_b, &mut rx_b, &state, 2, 3).await;
    settle_watch(&mut rx_a).await;
    settle_watch(&mut rx_b).await;
    std::fs::write(root_a.join("a.txt"), "a").unwrap();

    let changes_a = collect_changes(&mut rx_a).await;
    assert_eq!(changes_a.len(), 1, "client A got {changes_a:?}");
    assert_eq!(changes_a[0]["feature_id"], 1);
    assert_eq!(
        changes_a[0]["project_path"],
        root_a.to_string_lossy().as_ref()
    );
    assert!(
        rx_b.try_recv().is_err(),
        "client B must not see client A's root"
    );
}
