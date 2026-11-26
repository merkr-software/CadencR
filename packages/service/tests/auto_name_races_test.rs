//! Real Git and Codex adapters with an in-process HTTP router and disposable data.
mod common;
#[path = "common/provider_gate.rs"]
mod provider_gate;

use axum::body::Body;
use axum::extract::ws::Message;
use axum::http::{Request, StatusCode};
use axum::Router;
use cadencr_service::app_state::AppState;
use cadencr_service::domain::features::routes::features_router;
use cadencr_service::domain::git::repository::get_feature_setting;
use cadencr_service::domain::mcp::control::control_router;
use cadencr_service::domain::settings_store;
use cadencr_service::domain::ws_session::protocol::WsEnvelope;
use cadencr_service::shared::app_paths;
use cadencr_service::shared::migrate::{run_migrations, MigrationContext};
use common::{git_capture, git_in, worktree::init_git_repo};
use provider_gate::ProviderGate;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tower::ServiceExt;

struct Fixture {
    root: tempfile::TempDir,
    project: PathBuf,
    pool: SqlitePool,
    app: Router,
    events: mpsc::UnboundedReceiver<Message>,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        app_paths::pin_roots(Some(&data)).unwrap();
        settings_store::init(app_paths::settings_dir().unwrap());
        let binary = data.join("fake_codex_auto_name.py");
        std::fs::write(&binary, include_bytes!("fixtures/fake_codex_auto_name.py")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            data.join("provider_gate.py"),
            include_bytes!("fixtures/provider_gate.py"),
        )
        .unwrap();
        codex_app_server_sdk_rs::set_binary_override(Some(binary));

        let project = data.join("project");
        std::fs::create_dir(&project).unwrap();
        init_git_repo(&project);
        git_in(&project, &["config", "core.hooksPath", "/dev/null"]);

        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'Naming QA', ?)")
            .bind(project.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(
            "INSERT INTO features (id, project_id, title) VALUES (1, 1, 'Source'), (2, 1, 'Session 1');
             INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider, model)
             VALUES (10, 1, 'session', 'paused', 'codex_cli', 'qa-model'),
                    (20, 2, 'session', 'paused', 'codex_cli', 'qa-model');
             INSERT INTO feature_settings (feature_id, key, value) VALUES
                (2, 'worktree_mode', 'new'), (2, 'worktree_base_branch', 'missing-test-ref');",
        ).execute(&pool).await.unwrap();
        let state = AppState::with_pool(pool.clone());
        let (sender, events) = mpsc::unbounded_channel();
        state.ws_feature_senders.register(2, sender).await;
        let app = control_router().merge(features_router()).with_state(state);
        Self {
            root,
            project,
            pool,
            app,
            events,
        }
    }

    fn set_naming_provider(&self, provider: Value) {
        let settings = settings_store::paths::global_file(&settings_store::global_dir());
        settings_store::file::write_atomic(
            &settings,
            &json!({
                "agent_runtime_auto_name": provider, "model_auto_name": "qa-model"
            })
            .to_string(),
        )
        .unwrap();
    }

    async fn setting(&self, feature_id: i64, key: &str) -> String {
        get_feature_setting(&self.pool, feature_id, key)
            .await
            .unwrap()
            .unwrap()
    }

    async fn title(&self, feature_id: i64) -> String {
        sqlx::query_scalar("SELECT title FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    fn drain_events(&mut self) -> Vec<WsEnvelope> {
        std::iter::from_fn(|| self.events.try_recv().ok())
            .map(envelope)
            .collect()
    }

    async fn wait_for_initial_warning(&mut self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = envelope(self.events.recv().await.expect("feature output closed"));
                if event.action == "warning" && event.payload["code"] == "SETTINGS_INVALID" {
                    return;
                }
            }
        })
        .await
        .expect("initial naming warning before the explicit request");
    }

    fn turns(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("turns.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn envelope(message: Message) -> WsEnvelope {
    WsEnvelope::try_from(message.into_text().unwrap().to_string()).unwrap()
}

fn json_request(method: &str, path: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

fn send_prompt(session_id: i64, uuid: &str) -> Request<Body> {
    json_request(
        "POST",
        "/internal/mcp/project/send-message",
        json!({
            "source_feature_id": 1, "source_session_id": 10, "target_session_id": session_id,
            "message": "Fix login", "delivery": "send_now", "message_uuid": uuid,
        }),
    )
}

fn request(method: &str, path: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn retry_provisions_the_reserved_branch_and_delivers_before_naming_finishes() {
    let mut fixture = Fixture::new().await;
    let message_uuid = "6514c14d-b322-4b06-9bc7-6ebcbc2d74ab";
    fixture.set_naming_provider(json!([]));
    let first = fixture
        .app
        .clone()
        .oneshot(send_prompt(20, message_uuid))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let branch = fixture.setting(2, "worktree_branch").await;
    assert!(branch.starts_with("feature/feature-2-"), "{branch}");
    let (status, error): (String, String) =
        sqlx::query_as("SELECT status, error FROM agent_message_dispatches")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(status, "error");
    assert!(error.contains("missing-test-ref"), "{error}");
    assert!(!fixture.root.path().join("turns.jsonl").exists());
    fixture.wait_for_initial_warning().await;

    let repair = json_request(
        "PUT",
        "/api/features/2/settings",
        json!({
            "key": "worktree_base_branch", "value": "main",
        }),
    );
    assert_eq!(
        fixture.app.clone().oneshot(repair).await.unwrap().status(),
        StatusCode::OK
    );
    fixture.set_naming_provider(json!("codex_cli"));
    let gate = ProviderGate::arm(&fixture.project, "naming-result");
    let rename = tokio::spawn(
        fixture
            .app
            .clone()
            .oneshot(request("POST", "/api/features/2/auto-name")),
    );
    gate.wait().await;
    assert!(fixture
        .drain_events()
        .iter()
        .any(|event| event.action == "feature.autonaming" && event.payload["in_progress"] == true));

    let started = Instant::now();
    let retry = tokio::time::timeout(
        Duration::from_secs(10),
        fixture.app.clone().oneshot(send_prompt(20, message_uuid)),
    )
    .await
    .expect("the retry should dispatch while the naming result is still held")
    .unwrap();
    eprintln!(
        "reserved branch retry delivered in {} ms with naming held",
        started.elapsed().as_millis()
    );
    assert_eq!(retry.status(), StatusCode::OK);
    let cwd = fixture.setting(2, "worktree_path").await;
    let head = git_capture(Path::new(&cwd), &["symbolic-ref", "--short", "HEAD"]);
    assert_eq!(head.trim(), branch);
    assert_eq!(fixture.setting(2, "worktree_branch").await, branch);
    let turns = fixture.turns();
    assert_eq!(
        turns,
        vec![
            json!({"kind": "naming", "cwd": fixture.project}),
            json!({"kind": "prompt", "cwd": cwd})
        ]
    );
    let persisted: (String, i64) = sqlx::query_as(
        "SELECT d.status, d.attempt_count FROM agent_messages m
         JOIN agent_message_dispatches d ON d.message_id = m.id
         WHERE m.session_id = 20 AND m.message_type = 'user_message'",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!((persisted.0.as_str(), persisted.1), ("dispatched", 2));
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_messages WHERE session_id = 20 AND message_type = 'user_message'")
        .fetch_one(&fixture.pool).await.unwrap();
    assert_eq!(messages, 1);
    assert!(
        !rename.is_finished(),
        "the main turn was delivered before releasing naming"
    );

    assert_eq!(
        fixture
            .app
            .clone()
            .oneshot(json_request(
                "PUT",
                "/api/features/2/title",
                json!({"title": "Session 42"})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    gate.release();
    assert_eq!(rename.await.unwrap().unwrap().status(), StatusCode::OK);
    assert_eq!(fixture.title(2).await, "Session 42");
    assert_eq!(fixture.turns(), turns);
    let events = fixture.drain_events();
    let renamed: Vec<_> = events
        .iter()
        .filter(|event| event.action == "feature.renamed")
        .map(|event| event.payload["title"].as_str().unwrap())
        .collect();
    assert_eq!(renamed, ["Session 42"]);
    assert!(
        events
            .iter()
            .any(|event| event.action == "feature.autonaming"
                && event.payload["in_progress"] == false)
    );
    assert!(!events
        .iter()
        .any(|event| event.domain == "session"
            && matches!(event.action.as_str(), "warning" | "error")));

    // A fresh explicit request can replace the manual title it started with.
    assert_eq!(
        fixture
            .app
            .clone()
            .oneshot(request("POST", "/api/features/2/auto-name"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(fixture.title(2).await, "Check Login Flow");
    assert_eq!(fixture.setting(2, "worktree_branch").await, branch);
    assert_eq!(
        fixture
            .app
            .clone()
            .oneshot(request("DELETE", "/api/features/2"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_uncontended_first_prompt_names_its_branch(&fixture).await;
}

async fn assert_uncontended_first_prompt_names_its_branch(fixture: &Fixture) {
    sqlx::raw_sql(
        "INSERT INTO features (id, project_id, title) VALUES (3, 1, 'Session 2');
         INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider, model)
         VALUES (30, 3, 'session', 'paused', 'codex_cli', 'qa-model');
         INSERT INTO feature_settings (feature_id, key, value) VALUES (3, 'worktree_mode', 'new');",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let response = fixture
        .app
        .clone()
        .oneshot(send_prompt(30, "6d0c4e83-4b6b-4693-a451-b5f1248dd5bf"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(fixture.title(3).await, "Check Login Flow");
    let branch = fixture.setting(3, "worktree_branch").await;
    assert!(branch.starts_with("feature/check-login-flow-"), "{branch}");
    let cwd = fixture.setting(3, "worktree_path").await;
    let turns = fixture.turns();
    assert_eq!(
        &turns[3..],
        &[
            json!({"kind": "naming", "cwd": fixture.project}),
            json!({"kind": "prompt", "cwd": cwd}),
        ]
    );
    assert_eq!(
        fixture
            .app
            .clone()
            .oneshot(request("DELETE", "/api/features/3"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}
