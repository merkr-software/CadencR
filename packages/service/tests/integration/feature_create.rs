//! Validation cases for `POST /api/features` — exercised through the HTTP
//! handler. Sibling of `home_env/feature_worktree.rs` which covers the
//! `ensure_worktree` provisioning paths; split out so each file stays under
//! the 400-line cap.

use crate::common;

use common::{git_in, start_test_server};

#[tokio::test]
async fn create_feature_reuse_without_branch_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "needs branch",
            "worktree_mode": "reuse",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400, "{}", resp.text().await.unwrap());
}

#[tokio::test]
async fn create_feature_reuse_with_blank_branch_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "needs branch",
            "worktree_mode": "reuse",
            "reuse_branch": "   ",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn create_feature_reuse_with_flag_branch_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "flag branch",
            "worktree_mode": "reuse",
            "reuse_branch": "--upload-pack=evil",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn create_feature_reuse_with_invalid_branch_name_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "bad branch",
            "worktree_mode": "reuse",
            "reuse_branch": "feat bad",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn create_feature_reuse_with_missing_branch_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "missing branch",
            "worktree_mode": "reuse",
            "reuse_branch": "feature/not-there",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn create_feature_unknown_mode_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "bad mode",
            "worktree_mode": "bogus",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn create_feature_skip_persists_setting() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "no worktree",
            "worktree_mode": "skip",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_mode'",
    )
    .bind(id)
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(row.0, "skip");
}

#[tokio::test]
async fn create_feature_reuse_persists_branch_setting() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "reuse branch",
            "worktree_mode": "reuse",
            "reuse_branch": "feature/test-branch",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();
    let mode = sqlx::query_as::<_, (String,)>(
        "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_mode'",
    )
    .bind(id)
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(mode.0, "reuse");
    let branch = sqlx::query_as::<_, (String,)>(
        "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_reuse_branch'",
    )
    .bind(id)
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(branch.0, "feature/test-branch");
}

#[tokio::test]
async fn create_feature_reuse_trims_branch_before_persisting() {
    let server = start_test_server().await;
    git_in(&server.repo_path(), &["checkout", "-b", "feat/x"]);
    let resp = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&serde_json::json!({
            "project_id": 1,
            "title": "reuse branch trim",
            "worktree_mode": "reuse",
            "reuse_branch": " feat/x ",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();
    let branch = sqlx::query_as::<_, (String,)>(
        "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_reuse_branch'",
    )
    .bind(id)
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(branch.0, "feat/x");
}

#[tokio::test]
async fn set_feature_setting_rejects_reuse_mode_without_branch() {
    let server = start_test_server().await;
    let resp = server
        .client
        .put(format!("{}/api/features/1/settings", server.base_url))
        .json(&serde_json::json!({
            "key": "worktree_mode",
            "value": "reuse",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn set_feature_setting_trims_reuse_branch_before_persisting() {
    let server = start_test_server().await;
    git_in(&server.repo_path(), &["checkout", "-b", "feat/x"]);
    let branch_resp = server
        .client
        .put(format!("{}/api/features/1/settings", server.base_url))
        .json(&serde_json::json!({
            "key": "worktree_reuse_branch",
            "value": " feat/x ",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(branch_resp.status(), 200);
    let mode_resp = server
        .client
        .put(format!("{}/api/features/1/settings", server.base_url))
        .json(&serde_json::json!({
            "key": "worktree_mode",
            "value": " reuse ",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(mode_resp.status(), 200);

    let branch = sqlx::query_as::<_, (String,)>(
        "SELECT value FROM feature_settings WHERE feature_id = 1 AND key = 'worktree_reuse_branch'",
    )
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(branch.0, "feat/x");
}
