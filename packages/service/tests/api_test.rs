mod common;

use common::{apply_ws_upgrade_headers, start_test_server};

#[tokio::test]
async fn test_health_check() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/health", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "ok");
}

/// The loopback limiter must remain outside authentication so an untrusted
/// local page or process cannot create unbounded auth or WebSocket-upgrade
/// work. Its anonymous allowance must be isolated from valid renderer traffic.
#[tokio::test]
async fn loopback_anonymous_flood_does_not_starve_authenticated_requests() {
    const GENERAL_LIMIT: usize = 6000;

    let server = start_test_server().await;
    let unauthenticated_client = reqwest::Client::new();
    let url = format!("{}/api/health", server.base_url);

    for request_number in 1..=GENERAL_LIMIT {
        let status = unauthenticated_client
            .get(&url)
            .send()
            .await
            .expect("loopback request")
            .status();
        assert_eq!(
            status, 401,
            "request {request_number} should reach authentication"
        );
    }

    let response = unauthenticated_client
        .get(url)
        .send()
        .await
        .expect("rate-limited loopback request");
    assert_eq!(response.status(), 429);
    assert!(response
        .headers()
        .contains_key(reqwest::header::RETRY_AFTER));

    let authenticated_response = server
        .client
        .get(format!("{}/api/health", server.base_url))
        .send()
        .await
        .expect("authenticated loopback request");
    assert_eq!(
        authenticated_response.status(),
        200,
        "anonymous quota exhaustion must not block the renderer"
    );

    let tokenless_upgrade = apply_ws_upgrade_headers(
        unauthenticated_client.get(format!("{}/ws", server.base_url)),
        "http://localhost:1420",
    )
    .send()
    .await
    .expect("tokenless WebSocket upgrade");
    assert_eq!(
        tokenless_upgrade.status(),
        429,
        "tokenless upgrades remain bounded by the anonymous quota"
    );

    let authenticated_upgrade = apply_ws_upgrade_headers(
        server.client.get(format!("{}/ws", server.base_url)),
        "http://localhost:1420",
    )
    .header(
        reqwest::header::SEC_WEBSOCKET_PROTOCOL,
        "cadencr-token.test-token",
    )
    .send()
    .await
    .expect("authenticated WebSocket upgrade");
    assert_eq!(
        authenticated_upgrade.status(),
        101,
        "anonymous quota exhaustion must not block the renderer WebSocket"
    );
}

/// The OpenAPI count assertion is brittle: every new endpoint forces an
/// update. Switch to explicit lookups for the workflow-overhaul paths so a
/// new endpoint never breaks this test, and a removed one is loud.
#[tokio::test]
async fn test_openapi_includes_workflow_paths() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/openapi.json", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let paths = body["paths"].as_object().expect("paths object");

    let required = [
        "/api/git/branches",
        "/api/git/status",
        "/api/git/uncommitted-files",
        "/api/git/commit",
        "/api/git/push",
        "/api/git/push-input",
        "/api/git/compare-url",
        "/api/features/{id}/target-branch",
    ];
    for path in required {
        assert!(
            paths.contains_key(path),
            "OpenAPI spec missing path {path:?}; have {:?}",
            paths.keys().collect::<Vec<_>>()
        );
    }
}

#[tokio::test]
async fn test_feature_label_can_be_set_and_cleared() {
    let server = start_test_server().await;

    let set_resp = server
        .client
        .put(format!("{}/api/features/1/label", server.base_url))
        .json(&serde_json::json!({ "label": "  Review  " }))
        .send()
        .await
        .unwrap();
    assert_eq!(set_resp.status(), 200);

    let feature_resp = server
        .client
        .get(format!("{}/api/features/1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(feature_resp.status(), 200);
    let feature: serde_json::Value = feature_resp.json().await.unwrap();
    assert_eq!(feature["label"], "Review");

    let clear_resp = server
        .client
        .put(format!("{}/api/features/1/label", server.base_url))
        .json(&serde_json::json!({ "label": "   " }))
        .send()
        .await
        .unwrap();
    assert_eq!(clear_resp.status(), 200);

    let cleared_resp = server
        .client
        .get(format!("{}/api/features/1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared_resp.status(), 200);
    let cleared: serde_json::Value = cleared_resp.json().await.unwrap();
    assert!(cleared["label"].is_null());
}

#[tokio::test]
async fn test_get_branch() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/git/branch?project_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["branch"].is_string());
}

#[tokio::test]
async fn test_list_files() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!("{}/api/git/files?feature_id=1", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(!body.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_commit_log() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!(
            "{}/api/git/commit-log?feature_id=1",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(!body["commits"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_file_content() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!(
            "{}/api/git/file-content?feature_id=1&file_path=test.txt&mode=worktree",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["new_content"].is_string());
}

#[tokio::test]
async fn test_file_content_batch_has_file_path() {
    let server = start_test_server().await;
    let resp = server
        .client
        .post(format!("{}/api/git/file-content-batch", server.base_url))
        .json(&serde_json::json!({
            "feature_id": 1,
            "file_paths": ["test.txt"],
            "mode": "worktree"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let items = body.as_array().unwrap();
    assert!(!items.is_empty());
    for item in items {
        assert!(
            item["file_path"].is_string(),
            "each item should have file_path"
        );
    }
}

#[tokio::test]
async fn test_invalid_project_returns_404() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!(
            "{}/api/git/branch?project_id=9999",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn test_merge_conflicts_no_conflict() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!(
            "{}/api/git/merge-conflicts?project_id=1&feature_id=1",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["has_conflicts"], false);
}

#[tokio::test]
async fn test_file_blob_shas() {
    let server = start_test_server().await;
    let resp = server
        .client
        .get(format!(
            "{}/api/git/file-blob-shas?feature_id=1",
            server.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let items = body.as_array().unwrap();
    assert!(!items.is_empty(), "should return file blob shas");
    for item in items {
        assert!(item["sha"].is_string());
        assert!(item["file_path"].is_string());
    }
}

#[tokio::test]
async fn test_file_tree_includes_dotfiles() {
    let server = start_test_server().await;
    let repo_path = server.repo_path();

    std::fs::write(repo_path.join(".hidden"), "secret\n").unwrap();

    let resp = server
        .client
        .get(format!(
            "{}/api/editor/tree?project_id=1&dir_path=",
            server.base_url,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let entries = body.as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&".hidden"),
        "dotfiles should be included in file tree, got: {:?}",
        names
    );
    assert!(
        names.contains(&".git"),
        ".git dir should be included in file tree, got: {:?}",
        names
    );
}

#[tokio::test]
async fn test_ws_rejects_cross_origin() {
    let server = start_test_server().await;
    let resp = apply_ws_upgrade_headers(
        server.client.get(format!("{}/ws", server.base_url)),
        "https://evil.example",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_terminal_ws_rejects_cross_origin() {
    let server = start_test_server().await;
    let resp = apply_ws_upgrade_headers(
        server.client.get(format!(
            "{}/api/terminal/ws?feature_id=1&project_id=1",
            server.base_url
        )),
        "https://evil.example",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
}
