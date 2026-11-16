//! Integration tests for `GET /api/git/branches` and `GET /api/git/status`.
//! Sibling of `home_env/git_workflow.rs`; split out to keep each file under the
//! 400-line cap.

use crate::common;

use common::{git_in, stage_file, start_test_server, write_unstaged};

// ---------------------------------------------------------------------------
// GET /api/git/branches
// ---------------------------------------------------------------------------

#[tokio::test]
async fn branches_returns_local_and_remote() {
    let server = start_test_server().await;
    let repo = server.repo_path();

    // Synthesize a remote-tracking branch so `attached_worktree_path` and
    // `is_local=false` paths are exercised.
    git_in(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);

    let resp = server
        .client
        .get(format!("{}/api/git/branches?project_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let arr = body.as_array().expect("array");
    let names: Vec<&str> = arr.iter().map(|b| b["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"main"), "got: {names:?}");
    assert!(names.contains(&"feature/test-branch"));
    assert!(names.contains(&"origin/main"));

    let main = arr.iter().find(|b| b["name"] == "main").unwrap();
    assert_eq!(main["is_local"], true);
    let remote_main = arr.iter().find(|b| b["name"] == "origin/main").unwrap();
    assert_eq!(remote_main["is_local"], false);
}

#[tokio::test]
async fn branches_attached_worktree_field_is_populated() {
    // A second worktree on `main` makes the registry surface it as attached.
    let server = start_test_server().await;
    let repo = server.repo_path();
    let donor = server.tmp_dir.path().join("donor-wt");
    git_in(&repo, &["worktree", "add", donor.to_str().unwrap(), "main"]);

    let resp = server
        .client
        .get(format!("{}/api/git/branches?project_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let main = body
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["name"] == "main")
        .unwrap();
    assert!(
        main["attached_worktree_path"].is_string(),
        "main should report a worktree path; got {main}"
    );
}

#[tokio::test]
async fn branches_missing_project_returns_404() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!(
            "{}/api/git/branches?project_id=9999",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn branches_missing_param_returns_400() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/git/branches", server.base_url))
        .send()
        .await
        .unwrap();
    // Axum's Query extractor rejects with 400.
    assert_eq!(resp.status(), 400);
}

// ---------------------------------------------------------------------------
// GET /api/git/status
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_clean_tree() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/git/status?feature_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["uncommitted_count"], 0);
    assert_eq!(body["staged_count"], 0);
    assert_eq!(body["unstaged_count"], 0);
    assert_eq!(body["untracked_count"], 0);
    assert_eq!(body["has_remote"], false);
}

#[tokio::test]
async fn status_dirty_tree_counts_staged_and_unstaged() {
    let server = start_test_server().await;
    let repo = server.repo_path();
    stage_file(&repo, "staged.txt", Some("s\n"));
    write_unstaged(&repo, "unstaged.txt", "u\n");

    let resp = server
        .client
        .get(format!("{}/api/git/status?feature_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["uncommitted_count"].as_i64().unwrap() >= 2);
    assert!(body["staged_count"].as_i64().unwrap() >= 1);
    // `unstaged.txt` is untracked, so it lands in untracked_count, not unstaged.
    assert!(body["untracked_count"].as_i64().unwrap() >= 1);
}

#[tokio::test]
async fn status_no_remote() {
    // Default test repo has no remote configured; `ahead_of_remote` falls
    // back to "commits not reachable from any remote" when no upstream
    // exists — that is *every* local commit. We assert `has_remote=false`
    // and `behind_remote=0` (no upstream to be behind of).
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/git/status?feature_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["has_remote"], false);
    assert_eq!(body["behind_remote"], 0);
}

/// A plain project is an expected context, not a failing repository. Exercise
/// the same read endpoints mounted by the sidebar, Git tab and session header.
#[tokio::test]
async fn non_git_project_read_endpoints_return_empty_results() {
    let server = start_test_server().await;
    let plain = server.tmp_dir.path().join("plain-project");
    std::fs::create_dir(&plain).unwrap();
    std::fs::write(plain.join("notes.txt"), "ordinary project\n").unwrap();
    sqlx::query("UPDATE projects SET path = ? WHERE id = 1")
        .bind(plain.to_string_lossy().as_ref())
        .execute(&server.pool)
        .await
        .unwrap();
    // Retain a stale working-directory setting: it must not cause Git reads.
    sqlx::query(
        "UPDATE feature_settings SET value = ? WHERE feature_id = 1 AND key = 'worktree_path'",
    )
    .bind(plain.to_string_lossy().as_ref())
    .execute(&server.pool)
    .await
    .unwrap();

    for (path, expected) in [
        ("branch?project_id=1", serde_json::json!({"branch": null})),
        ("branches?project_id=1", serde_json::json!([])),
        ("worktrees?project_id=1", serde_json::json!([])),
        ("feature-worktrees?project_id=1", serde_json::json!([])),
        (
            "worktree/info?project_id=1&feature_id=1",
            serde_json::json!(null),
        ),
        (
            "stats?feature_id=1",
            serde_json::json!({"files_changed": 0, "insertions": 0, "deletions": 0}),
        ),
        (
            "diff?feature_id=1&mode=worktree",
            serde_json::json!({"diff": ""}),
        ),
        (
            "changed-files?feature_id=1&mode=worktree",
            serde_json::json!([]),
        ),
        ("files?feature_id=1", serde_json::json!([])),
        ("file-blob-shas?feature_id=1", serde_json::json!([])),
        ("stashes?feature_id=1", serde_json::json!([])),
        (
            "has-uncommitted-changes?project_id=1&feature_id=1",
            serde_json::json!({"has_changes": false}),
        ),
        ("uncommitted-files?feature_id=1", serde_json::json!([])),
        (
            "blame?project_id=1&feature_id=1&file_path=notes.txt",
            serde_json::json!({"lines": []}),
        ),
    ] {
        let response = server
            .client
            .get(format!("{}/api/git/{path}", server.base_url))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(status, 200, "{path}: {body}");
        assert_eq!(body, expected, "{path}");
    }
    let response = server
        .client
        .get(format!("{}/api/git/status?feature_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["current_branch"], "");
    assert_eq!(body["has_remote"], false);
    assert_eq!(body["uncommitted_count"], 0);

    let response = server
        .client
        .get(format!("{}/api/git/pr?feature_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let pr: serde_json::Value = response.json().await.unwrap();
    assert!(
        pr["error"].is_null(),
        "plain projects must not show a forge error: {pr}"
    );
    assert!(pr["pr"].is_null());

    // The working-directory resolver must keep supporting non-Git consumers,
    // in particular custom actions, while the Git resolver returns no path.
    let state = cadencr_service::app_state::AppState::with_pool(server.pool.clone());
    assert_eq!(
        cadencr_service::domain::git::service::resolve_feature_working_path(&state, 1)
            .await
            .unwrap()
            .as_deref(),
        plain.to_str()
    );
    assert!(
        cadencr_service::domain::git::service::resolve_feature_git_path(&state, 1)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn uncommitted_files_missing_feature_still_returns_404() {
    let server = start_test_server().await;
    let response = server
        .client
        .get(format!(
            "{}/api/git/uncommitted-files?feature_id=9999",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}
