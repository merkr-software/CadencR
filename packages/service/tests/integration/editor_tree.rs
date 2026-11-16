//! End-to-end coverage for the editor file tree's gitignore handling
//! (issue #41): a path added to `.gitignore` must stay visible in the tree —
//! marked ignored so the UI dims it — instead of vanishing. Exercises the
//! real axum router → `tree-all` handler → JSON, the same path the desktop
//! file tree hits with `exclude_gitignored=true`.

use crate::common;

use common::{find_file_row, start_test_server};

async fn fetch_fast_tree(server: &common::TestServer) -> serde_json::Value {
    let resp = server
        .client
        .get(format!(
            "{}/api/editor/tree-all?project_id=1&feature_id=1&exclude_gitignored=true",
            server.base_url,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

#[tokio::test]
async fn newly_ignored_file_in_a_folder_stays_listed_and_dimmed() {
    let server = start_test_server().await;
    let repo = server.repo_path();

    // The exact repro: create a file inside a folder.
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/app.ts"), "ok").unwrap();
    std::fs::write(repo.join("src/debug.log"), "noise").unwrap();

    // Before ignoring: the file is listed and not marked ignored.
    let before = fetch_fast_tree(&server).await;
    let row = find_file_row(&before, "src/debug.log").expect("file listed before ignoring");
    assert_eq!(row["is_gitignored"], serde_json::json!(false));

    // The user adds it to `.gitignore`.
    std::fs::write(repo.join(".gitignore"), "src/debug.log\n").unwrap();

    // After ignoring: it must STILL be listed, now flagged for dimming.
    let after = fetch_fast_tree(&server).await;
    let row = find_file_row(&after, "src/debug.log")
        .expect("issue #41 regression: ignored file vanished from the tree");
    assert_eq!(
        row["is_gitignored"],
        serde_json::json!(true),
        "ignored file must be marked so the UI dims it"
    );
    assert_eq!(row["is_dir"], serde_json::json!(false));
    // The non-ignored sibling and parent folder are unaffected.
    assert_eq!(
        find_file_row(&after, "src/app.ts").unwrap()["is_gitignored"],
        serde_json::json!(false)
    );
    assert_eq!(
        find_file_row(&after, "src").unwrap()["is_gitignored"],
        serde_json::json!(false)
    );
}

#[tokio::test]
async fn ignored_directory_is_listed_as_a_leaf_not_descended() {
    let server = start_test_server().await;
    let repo = server.repo_path();

    std::fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
    std::fs::write(repo.join("node_modules/pkg/index.js"), "x").unwrap();
    std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();

    let body = fetch_fast_tree(&server).await;

    let dir = find_file_row(&body, "node_modules").expect("ignored dir listed");
    assert_eq!(dir["is_gitignored"], serde_json::json!(true));
    assert_eq!(dir["is_dir"], serde_json::json!(true));
    // Must stay cheap: never walk into the ignored directory on the fast pass.
    assert!(
        find_file_row(&body, "node_modules/pkg").is_none(),
        "ignored directory contents must not be eagerly listed",
    );
}
