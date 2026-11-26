//! Exercise Git routes and subscriptions against a real disposable linked checkout.

use std::path::{Path, PathBuf};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::json;
use tower::ServiceExt;

use super::support::*;
use crate::domain::git::{feature_dir::WORKTREE_UNAVAILABLE, repository, routes::git_router};
use crate::shared::git_cli::run_git;

const PARENT_FILE: &str = "qa-root-only.txt";
const FEATURE_FILE: &str = "qa-worktree-only.txt";

struct CheckoutFixture {
    _dir: tempfile::TempDir,
    parent: PathBuf,
    checkout: PathBuf,
    state: AppState,
    api: Router,
}

impl CheckoutFixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("repo");
        let checkout = dir.path().join("checkout");
        std::fs::create_dir(&parent).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "--no-gpg-sign",
                "-qm",
                "initial",
            ],
            &["branch", "another-branch"],
            &[
                "worktree",
                "add",
                "-qb",
                "topic",
                checkout.to_str().unwrap(),
            ],
        ] {
            run_git(args, &parent).await.unwrap();
        }
        std::fs::write(parent.join(PARENT_FILE), "parent\n").unwrap();
        std::fs::write(parent.join("staged.txt"), "staged\n").unwrap();
        run_git(&["add", "staged.txt"], &parent).await.unwrap();
        std::fs::write(checkout.join(FEATURE_FILE), "checkout\n").unwrap();

        let pool = crate::shared::test_query_plan::migrated_pool().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'Project', ?)")
            .bind(parent.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title) VALUES
             (1, 1, 'Linked checkout'), (2, 1, 'Project branch'), (3, 1, 'Legacy project branch')",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (feature_id, key, value) in [
            (1, "worktree_path", checkout.to_str().unwrap()),
            (1, "worktree_branch", "topic"),
            (1, "target_branch", "main"),
            (2, "worktree_mode", "skip"),
            (3, "worktree_path", parent.to_str().unwrap()),
        ] {
            repository::set_feature_setting(&pool, feature_id, key, value)
                .await
                .unwrap();
        }
        let state = AppState::with_pool(pool);
        let api = git_router().with_state(state.clone());
        Self {
            _dir: dir,
            parent,
            checkout,
            state,
            api,
        }
    }

    async fn request(&self, method: Method, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = self
            .api
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 32_768).await.unwrap();
        let body = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("{path}: {status}, {}", String::from_utf8_lossy(&bytes)));
        (status, body)
    }

    async fn get(&self, path: &str) -> Value {
        let (status, body) = self.request(Method::GET, path, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        body
    }

    async fn assert_unavailable(&self, method: Method, path: &str, payload: Value) {
        let (status, body) = self.request(method, path, payload).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}: {body}");
        assert_eq!(body["code"], WORKTREE_UNAVAILABLE, "{path}: {body}");
    }

    async fn assert_checkout(&self, feature_id: i64, branch: &str, file: &str, excluded: &str) {
        let status = self
            .get(&format!("/api/git/status?feature_id={feature_id}"))
            .await;
        assert_eq!(status["current_branch"], branch);
        let changes = self
            .get(&format!(
                "/api/git/changed-files?feature_id={feature_id}&mode=worktree"
            ))
            .await;
        let files = changes.as_array().unwrap();
        assert!(files.iter().any(|entry| entry["file"] == file), "{changes}");
        assert!(
            files.iter().all(|entry| entry["file"] != excluded),
            "{changes}"
        );
    }
}

#[tokio::test]
async fn assigned_checkout_outage_refuses_git_routes_and_cannot_write_to_the_project() {
    let fixture = CheckoutFixture::new().await;
    fixture
        .assert_checkout(1, "topic", FEATURE_FILE, PARENT_FILE)
        .await;
    std::fs::rename(
        &fixture.checkout,
        fixture.checkout.with_extension("offline"),
    )
    .unwrap();
    fixture
        .assert_checkout(2, "main", PARENT_FILE, FEATURE_FILE)
        .await;
    fixture
        .assert_checkout(3, "main", PARENT_FILE, FEATURE_FILE)
        .await;
    let index = std::fs::read(fixture.parent.join(".git/index")).unwrap();
    let head = run_git(&["rev-parse", "HEAD"], &fixture.parent)
        .await
        .unwrap();

    for path in [
        "/api/git/status?feature_id=1",
        "/api/git/changed-files?feature_id=1&mode=worktree",
        "/api/git/changed-files?feature_id=1&mode=branch&target_branch=main",
        "/api/git/stats?feature_id=1&mode=branch&target_branch=main",
        "/api/git/diff?feature_id=1&mode=branch&target_branch=main",
        "/api/git/file-diff?feature_id=1&file_path=qa-root-only.txt&mode=worktree",
        "/api/git/file-blob-shas?feature_id=1",
        "/api/git/uncommitted-files?feature_id=1",
    ] {
        fixture
            .assert_unavailable(Method::GET, path, Value::Null)
            .await;
    }
    for (path, body) in [
        (
            "commit",
            json!({ "feature_id": 1, "message": "unexpected", "file_paths": [PARENT_FILE] }),
        ),
        (
            "index/stage",
            json!({ "feature_id": 1, "file_path": PARENT_FILE }),
        ),
        (
            "index/reset",
            json!({ "feature_id": 1, "file_path": "staged.txt" }),
        ),
        (
            "checkout",
            json!({ "feature_id": 1, "project_id": 1, "branch": "another-branch" }),
        ),
        ("push", json!({ "feature_id": 1 })),
        (
            "stashes/push",
            json!({ "feature_id": 1, "include_untracked": true }),
        ),
        (
            "update-branch",
            json!({ "feature_id": 1, "strategy": "merge" }),
        ),
        ("update-branch/continue", json!({ "feature_id": 1 })),
        ("update-branch/abort", json!({ "feature_id": 1 })),
        ("merge", json!({ "feature_id": 1, "project_id": 1 })),
    ] {
        fixture
            .assert_unavailable(Method::POST, &format!("/api/git/{path}"), body)
            .await;
    }
    fixture
        .assert_unavailable(
            Method::DELETE,
            "/api/git/branch?project_id=1&feature_id=1",
            Value::Null,
        )
        .await;
    assert_eq!(
        std::fs::read(fixture.parent.join(".git/index")).unwrap(),
        index
    );
    assert_eq!(
        run_git(&["rev-parse", "HEAD"], &fixture.parent)
            .await
            .unwrap(),
        head
    );
    assert_eq!(
        run_git(&["branch", "--show-current"], &fixture.parent)
            .await
            .unwrap()
            .trim(),
        "main"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.parent.join(PARENT_FILE)).unwrap(),
        "parent\n"
    );

    std::fs::rename(
        fixture.checkout.with_extension("offline"),
        &fixture.checkout,
    )
    .unwrap();
    fixture
        .assert_checkout(1, "topic", FEATURE_FILE, PARENT_FILE)
        .await;
    let (status, result) = fixture
        .request(
            Method::POST,
            "/api/git/index/stage",
            json!({ "feature_id": 1, "file_path": FEATURE_FILE }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        run_git(&["diff", "--cached", "--name-only"], &fixture.checkout)
            .await
            .unwrap()
            .trim(),
        FEATURE_FILE
    );
    assert_eq!(
        std::fs::read(fixture.parent.join(".git/index")).unwrap(),
        index
    );

    let (status, result) = fixture
        .request(
            Method::POST,
            "/api/git/checkout",
            json!({ "feature_id": 2, "project_id": 1, "branch": "another-branch" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    fixture
        .assert_checkout(2, "another-branch", PARENT_FILE, FEATURE_FILE)
        .await;
    fixture
        .assert_checkout(1, "topic", FEATURE_FILE, PARENT_FILE)
        .await;
}

#[tokio::test]
async fn assigned_checkout_outage_refuses_a_marker_pointing_to_the_parent() {
    let fixture = CheckoutFixture::new().await;
    std::fs::write(
        fixture.checkout.join(".git"),
        format!("gitdir: {}\n", fixture.parent.join(".git").display()),
    )
    .unwrap();
    fixture
        .assert_unavailable(Method::GET, "/api/git/status?feature_id=1", Value::Null)
        .await;
    fixture
        .assert_unavailable(
            Method::GET,
            "/api/git/file-blob-shas?feature_id=1",
            Value::Null,
        )
        .await;
}

#[tokio::test]
async fn assigned_checkout_outage_rejects_reopen_and_retry_binds_the_restored_checkout() {
    let fixture = CheckoutFixture::new().await;
    let watcher = &fixture.state.git_watcher;
    let checkout = &fixture.checkout;
    let sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (mounted, mut mounted_rx) = mpsc::unbounded_channel();
    let (reopened, mut reopened_rx) = mpsc::unbounded_channel();
    let request = || make_envelope("app", "subscribe.git_status", json!({ "feature_id": 1 }));
    dispatch_envelope(request(), &mounted, &sessions, &fixture.state).await;
    let attached = next_reply(&mut mounted_rx).await;
    assert_eq!(attached.payload["current_branch"], "topic");
    assert_eq!(attached.payload.get("watcher_error"), Some(&Value::Null));

    std::fs::rename(checkout, checkout.with_extension("offline")).unwrap();
    watcher.confirm_after_write(checkout, &fixture.state).await;
    let outage = next_where(&mut mounted_rx, |env| env.action == "status_error").await;
    assert_eq!(outage.action, "status_error");
    assert_eq!(outage.payload["code"], WORKTREE_UNAVAILABLE);
    assert!(outage.payload.get("watcher_error").is_none());
    let reopen = request();
    let reopen_id = reopen.id.clone();
    dispatch_envelope(reopen, &reopened, &sessions, &fixture.state).await;
    let unavailable = next_reply(&mut reopened_rx).await;
    assert_eq!(unavailable.action, "status_error");
    assert_eq!(unavailable.r#ref.as_deref(), Some(reopen_id.as_str()));
    assert_eq!(unavailable.payload["code"], WORKTREE_UNAVAILABLE);
    assert!(unavailable.payload.get("watcher_error").is_none());
    watcher
        .confirm_after_write(&fixture.parent, &fixture.state)
        .await;
    assert!(
        reopened_rx.try_recv().is_err(),
        "the project watcher must not answer for this feature"
    );

    std::fs::rename(checkout.with_extension("offline"), checkout).unwrap();
    watcher.confirm_after_write(checkout, &fixture.state).await;
    let automatic = next_where(&mut mounted_rx, |env| env.action == "status").await;
    assert_eq!(automatic.payload["current_branch"], "topic");
    assert_eq!(
        automatic.payload.get("watcher_error"),
        Some(&Value::Null),
        "recovery must acknowledge a replacement watcher"
    );
    let retry = request();
    let retry_id = retry.id.clone();
    dispatch_envelope(retry, &reopened, &sessions, &fixture.state).await;
    let restored = next_reply(&mut reopened_rx).await;
    assert_eq!(restored.r#ref.as_deref(), Some(retry_id.as_str()));
    assert_eq!(restored.payload["current_branch"], "topic");
    assert_eq!(restored.payload["target_resolved"], true);
    assert_eq!(restored.payload.get("watcher_error"), Some(&Value::Null));
    assert_restored_refresh(checkout, &fixture.state, &mut reopened_rx).await;
    watcher.shutdown().await;
}

async fn assert_restored_refresh(
    path: &Path,
    state: &AppState,
    rx: &mut mpsc::UnboundedReceiver<Message>,
) {
    std::fs::write(path.join("another.txt"), "live edit\n").unwrap();
    state.git_watcher.confirm_after_write(path, state).await;
    let envelope = next_where(rx, |env| env.payload["untracked_count"] == 2).await;
    assert_eq!(envelope.action, "status");
    assert_eq!(envelope.payload["current_branch"], "topic");
    assert_eq!(envelope.payload["untracked_count"], 2);
}

async fn next_reply(rx: &mut mpsc::UnboundedReceiver<Message>) -> WsEnvelope {
    next_where(rx, |env| env.r#ref.is_some()).await
}

async fn next_where(
    rx: &mut mpsc::UnboundedReceiver<Message>,
    matches: impl Fn(&WsEnvelope) -> bool,
) -> WsEnvelope {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let Message::Text(text) = rx.recv().await.expect("Git stream closed") else {
                panic!("expected a text envelope");
            };
            let envelope = serde_json::from_str(&text).unwrap();
            if matches(&envelope) {
                return envelope;
            }
        }
    })
    .await
    .expect("matching Git status timed out")
}
