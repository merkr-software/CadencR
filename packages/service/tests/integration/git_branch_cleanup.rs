//! Integration tests for branch cleanup edge cases in the archive flow.

use crate::common;

use common::{git_capture, git_in, start_test_server};

async fn delete_worktree_path_setting(server: &common::TestServer) {
    sqlx::query("DELETE FROM feature_settings WHERE feature_id = 1 AND key = 'worktree_path'")
        .execute(&server.pool)
        .await
        .unwrap();
}

async fn set_feature_setting(server: &common::TestServer, key: &str, value: &str) {
    sqlx::query(
        "INSERT OR REPLACE INTO feature_settings (feature_id, key, value) VALUES (1, ?, ?)",
    )
    .bind(key)
    .bind(value)
    .execute(&server.pool)
    .await
    .unwrap();
}

async fn delete_feature_branch(server: &common::TestServer, force: bool) -> serde_json::Value {
    let branch_resp = server
        .client
        .delete(format!(
            "{}/api/git/branch?project_id=1&feature_id=1&force={force}",
            server.base_url,
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(branch_resp.status(), 200);
    branch_resp.json().await.unwrap()
}

#[tokio::test]
async fn delete_no_worktree_current_branch_checks_out_target_then_deletes_branch() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    delete_worktree_path_setting(&server).await;
    set_feature_setting(&server, "target_branch", "main").await;
    assert_eq!(
        git_capture(&repo, &["branch", "--show-current"]).trim(),
        "feature/test-branch"
    );

    let body = delete_feature_branch(&server, true).await;

    assert_eq!(body["success"], true, "{body:?}");
    assert_eq!(
        git_capture(&repo, &["branch", "--show-current"]).trim(),
        "main"
    );
    assert!(
        git_capture(&repo, &["branch", "--list", "feature/test-branch"])
            .trim()
            .is_empty()
    );
}

#[tokio::test]
async fn safe_delete_uses_feature_target_instead_of_unrelated_current_branch() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    delete_worktree_path_setting(&server).await;
    set_feature_setting(&server, "target_branch", "main").await;
    git_in(&repo, &["checkout", "main"]);
    git_in(&repo, &["branch", "unrelated"]);
    git_in(
        &repo,
        &[
            "merge",
            "--no-ff",
            "feature/test-branch",
            "-m",
            "merge feature",
        ],
    );
    git_in(&repo, &["checkout", "unrelated"]);

    let body = delete_feature_branch(&server, false).await;

    assert_eq!(body["success"], true, "{body:?}");
    assert_eq!(
        git_capture(&repo, &["branch", "--show-current"]).trim(),
        "unrelated"
    );
    assert!(
        git_capture(&repo, &["branch", "--list", "feature/test-branch"])
            .trim()
            .is_empty()
    );
}

#[tokio::test]
async fn safe_delete_blocks_a_branch_not_merged_into_its_feature_target() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    delete_worktree_path_setting(&server).await;
    set_feature_setting(&server, "target_branch", "main").await;

    let body = delete_feature_branch(&server, false).await;

    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "unmerged_branch");
    assert!(body["error"]
        .as_str()
        .is_some_and(|error| error.contains("target branch 'main'")));
    assert_eq!(
        git_capture(&repo, &["branch", "--show-current"]).trim(),
        "feature/test-branch"
    );
    assert!(
        !git_capture(&repo, &["branch", "--list", "feature/test-branch"])
            .trim()
            .is_empty()
    );
}

#[tokio::test]
async fn delete_separate_worktree_target_branch_is_blocked_even_when_forced() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    let worktree = server.tmp_dir.path().join("target-worktree");
    git_in(&repo, &["branch", "feature/archive-target", "main"]);
    git_in(
        &repo,
        &[
            "worktree",
            "add",
            worktree.to_str().unwrap(),
            "feature/archive-target",
        ],
    );
    set_feature_setting(
        &server,
        "worktree_path",
        worktree.to_string_lossy().as_ref(),
    )
    .await;
    set_feature_setting(&server, "worktree_branch", "feature/archive-target").await;
    set_feature_setting(&server, "target_branch", "feature/archive-target").await;

    let body = delete_feature_branch(&server, true).await;

    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "target_branch");
    assert!(
        !git_capture(&repo, &["branch", "--list", "feature/archive-target"])
            .trim()
            .is_empty()
    );
}

#[tokio::test]
async fn delete_no_worktree_target_branch_is_blocked() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    git_in(&repo, &["checkout", "main"]);
    delete_worktree_path_setting(&server).await;
    set_feature_setting(&server, "worktree_branch", "main").await;
    set_feature_setting(&server, "target_branch", "main").await;

    let body = delete_feature_branch(&server, true).await;

    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "target_branch");
    assert_eq!(
        git_capture(&repo, &["branch", "--show-current"]).trim(),
        "main"
    );
}

#[tokio::test]
async fn delete_no_worktree_keeps_branch_when_target_checkout_fails() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    delete_worktree_path_setting(&server).await;
    set_feature_setting(&server, "target_branch", "missing-target").await;

    let body = delete_feature_branch(&server, true).await;

    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "checkout_failed");
    assert_eq!(
        git_capture(&repo, &["branch", "--show-current"]).trim(),
        "feature/test-branch"
    );
    assert_eq!(
        git_capture(&repo, &["branch", "--list", "feature/test-branch"]).trim(),
        "* feature/test-branch"
    );
}

#[tokio::test]
async fn delete_default_branch_is_blocked_even_when_target_differs() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    delete_worktree_path_setting(&server).await;
    set_feature_setting(&server, "worktree_branch", "main").await;
    set_feature_setting(&server, "target_branch", "feature/test-branch").await;

    let body = delete_feature_branch(&server, true).await;

    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "default_branch");
    assert_eq!(
        git_capture(&repo, &["branch", "--list", "main"]).trim(),
        "main"
    );
}

#[tokio::test]
async fn delete_default_worktree_is_blocked() {
    let server = start_test_server().await;

    let resp = server
        .client
        .delete(format!(
            "{}/api/git/worktree/safe?project_id=1&feature_id=1&force=true",
            server.base_url
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "default_worktree");
}

#[tokio::test]
async fn remove_orphan_default_worktree_is_blocked() {
    let server = start_test_server().await;
    let repo_path = server.repo_path().to_string_lossy().to_string();

    let resp = server
        .client
        .delete(format!("{}/api/git/worktree/orphan", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "worktree_path": repo_path,
            "force": true,
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["success"], false, "{body:?}");
    assert_eq!(body["blocked_reason"], "default_worktree");
}

#[tokio::test]
async fn feature_worktrees_marks_default_branch() {
    let server = start_test_server().await;
    set_feature_setting(&server, "worktree_branch", "main").await;

    let resp = server
        .client
        .get(format!(
            "{}/api/git/feature-worktrees?project_id=1",
            server.base_url
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body[0]["is_default_branch"], true);
    assert_eq!(body[0]["is_main_worktree"], true);
}
