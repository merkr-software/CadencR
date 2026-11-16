//! Integration tests for the write-side Git workflow endpoints — `commit`,
//! `push-input`, `target-branch`, `uncommitted-files`. Branches/status live in
//! the sibling `integration/git_status.rs`.

use crate::common;

use common::worktree::{worktree_remove, HomeGuard};
use common::{
    find_file_row, git_capture, git_in, stage_file, start_test_server, write_unstaged, TestServer,
};

// ---------------------------------------------------------------------------
// POST /api/git/worktree
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_worktree_copies_provider_config_before_returning() {
    let tmp_home = tempfile::tempdir().unwrap();
    let _guard = HomeGuard::set(tmp_home.path());
    let server = start_test_server().await;
    let repo = server.repo_path();

    std::fs::create_dir_all(repo.join(".claude")).unwrap();
    std::fs::write(
        repo.join(".claude/settings.local.json"),
        r#"{"permissions":{}}"#,
    )
    .unwrap();

    let resp = server
        .client
        .post(format!("{}/api/git/worktree", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "feature_id": 1,
            "feature_title": "copy provider config"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let wt_path = std::path::PathBuf::from(body["worktree_path"].as_str().unwrap());

    assert_eq!(
        std::fs::read_to_string(wt_path.join(".claude/settings.local.json")).unwrap(),
        r#"{"permissions":{}}"#
    );

    worktree_remove(&repo, &wt_path);
}

#[tokio::test]
async fn delete_worktree_then_branch_keeps_branch_metadata() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    let wt_path = server.tmp_dir.path().join("archive-wt");
    git_in(&repo, &["branch", "feature/archive-cleanup", "main"]);
    git_in(
        &repo,
        &[
            "worktree",
            "add",
            wt_path.to_str().unwrap(),
            "feature/archive-cleanup",
        ],
    );
    sqlx::query(
        "UPDATE feature_settings SET value = ? WHERE feature_id = 1 AND key = 'worktree_path'",
    )
    .bind(wt_path.to_string_lossy().to_string())
    .execute(&server.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE feature_settings SET value = 'feature/archive-cleanup' \
         WHERE feature_id = 1 AND key = 'worktree_branch'",
    )
    .execute(&server.pool)
    .await
    .unwrap();

    let wt_resp = server
        .client
        .delete(format!(
            "{}/api/git/worktree/safe?project_id=1&feature_id=1",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(wt_resp.status(), 200);

    let branch_resp = server
        .client
        .delete(format!(
            "{}/api/git/branch?project_id=1&feature_id=1&force=true",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(branch_resp.status(), 200);
    let body: serde_json::Value = branch_resp.json().await.unwrap();
    assert_eq!(body["success"], true, "{body:?}");
}

// ---------------------------------------------------------------------------
// PATCH /api/features/{id}/target-branch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn target_branch_happy_path() {
    let server = start_test_server().await;
    let resp = server
        .client
        .patch(format!("{}/api/features/1/target-branch", server.base_url))
        .json(&serde_json::json!({ "target_branch": "main" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["success"], true);
}

#[tokio::test]
async fn target_branch_invalid_branch_rejected() {
    let server = start_test_server().await;
    let resp = server
        .client
        .patch(format!("{}/api/features/1/target-branch", server.base_url))
        .json(&serde_json::json!({ "target_branch": "no-such-branch" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn target_branch_empty_rejected() {
    let server = start_test_server().await;
    let resp = server
        .client
        .patch(format!("{}/api/features/1/target-branch", server.base_url))
        .json(&serde_json::json!({ "target_branch": "   " }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

// ---------------------------------------------------------------------------
// GET /api/git/uncommitted-files
// ---------------------------------------------------------------------------

async fn fetch_uncommitted(server: &TestServer) -> serde_json::Value {
    let resp = server
        .client
        .get(format!(
            "{}/api/git/uncommitted-files?feature_id=1",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

#[tokio::test]
async fn uncommitted_files_staged_only() {
    let server = start_test_server().await;
    stage_file(&server.repo_path(), "staged.txt", Some("hi\n"));

    let body = fetch_uncommitted(&server).await;
    let row = find_file_row(&body, "staged.txt").expect("staged.txt missing");
    assert_eq!(row["status"], "staged");
}

#[tokio::test]
async fn uncommitted_files_unstaged_only() {
    let server = start_test_server().await;
    // Modify a tracked file *without* staging.
    write_unstaged(&server.repo_path(), "test.txt", "modified\n");

    let body = fetch_uncommitted(&server).await;
    let row = find_file_row(&body, "test.txt").expect("test.txt missing");
    assert_eq!(row["status"], "unstaged");
}

#[tokio::test]
async fn uncommitted_files_untracked() {
    let server = start_test_server().await;
    write_unstaged(&server.repo_path(), "new.txt", "new\n");

    let body = fetch_uncommitted(&server).await;
    let row = find_file_row(&body, "new.txt").expect("new.txt missing");
    assert_eq!(row["status"], "untracked");
}

#[tokio::test]
async fn uncommitted_files_mixed_staged_and_unstaged() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    // Stage a change to test.txt then dirty the worktree on top.
    write_unstaged(&repo, "test.txt", "stage v1\n");
    git_in(&repo, &["add", "--", "test.txt"]);
    write_unstaged(&repo, "test.txt", "stage v1 + worktree v2\n");

    let body = fetch_uncommitted(&server).await;
    let row = find_file_row(&body, "test.txt").expect("test.txt missing");
    assert_eq!(row["status"], "both");
}

// ---------------------------------------------------------------------------
// POST /api/git/commit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn commit_happy_path_subset_of_files() {
    let server = start_test_server().await;
    let repo = server.repo_path();

    write_unstaged(&repo, "first.txt", "first\n");
    write_unstaged(&repo, "second.txt", "second\n");

    let resp = server
        .client
        .post(format!("{}/api/git/commit", server.base_url))
        .json(&serde_json::json!({
            "feature_id": 1,
            "message": "add first only",
            "file_paths": ["first.txt"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["success"], true, "commit failed: {body}");

    // Only first.txt should be in HEAD; second.txt remains untracked.
    let log = git_capture(&repo, &["log", "-1", "--name-only", "--pretty=format:"]);
    assert!(log.contains("first.txt"), "log was: {log}");
    assert!(!log.contains("second.txt"), "log was: {log}");
}

#[tokio::test]
async fn commit_missing_message_rejected() {
    let server = start_test_server().await;
    write_unstaged(&server.repo_path(), "only.txt", "x\n");

    let resp = server
        .client
        .post(format!("{}/api/git/commit", server.base_url))
        .json(&serde_json::json!({
            "feature_id": 1,
            "message": "   ",
            "file_paths": ["only.txt"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn commit_no_files_rejected() {
    let server = start_test_server().await;

    let resp = server
        .client
        .post(format!("{}/api/git/commit", server.base_url))
        .json(&serde_json::json!({
            "feature_id": 1,
            "message": "no files",
            "file_paths": serde_json::Value::Array(Vec::new()),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

// ---------------------------------------------------------------------------
// POST /api/git/push-input
// ---------------------------------------------------------------------------

#[tokio::test]
async fn push_input_without_session_returns_error_payload() {
    // No push has been started for feature 1, so the input must be refused.
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/git/push-input", server.base_url))
        .json(&serde_json::json!({
            "feature_id": 1,
            "text": "passphrase",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["success"], false);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no active push"),
        "unexpected error: {body}"
    );
}

#[tokio::test]
async fn push_input_with_active_session_delivers_to_pty() {
    // We can't reach the registry through the HTTP API alone (registration
    // happens inside `push`, which spawns a real PTY), so build a parallel
    // AppState that shares the test pool but has a registry we control, and
    // call `push_input` directly.
    use cadencr_service::app_state::AppState;
    use cadencr_service::domain::git::push_sessions::{PushSessionRegistry, SensitiveInput};
    use cadencr_service::domain::git::workflow_service;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    let registry = Arc::new(PushSessionRegistry::new());
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<SensitiveInput>();
    assert!(
        registry.register(1, stdin_tx).await,
        "registry must accept the first registration"
    );

    let server = start_test_server().await;
    let mut state = AppState::with_pool(server.pool.clone());
    state.push_sessions = registry.clone();

    let result = workflow_service::push_input(
        &state,
        cadencr_service::domain::git::models::PushInputBody {
            feature_id: 1,
            text: "secret".into(),
        },
    )
    .await
    .unwrap();
    assert!(result.success, "service call should succeed: {result:?}");

    let delivered = stdin_rx.try_recv().expect("input must be delivered");
    assert_eq!(
        delivered.as_ref(),
        b"secret\n",
        "push_input must append the trailing \\n"
    );
    registry.unregister(1).await;
}
