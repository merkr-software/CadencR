//! Replay queue/steering through HTTP, WS, the service, and a Codex subprocess.
mod common;
#[path = "common/provider_gate.rs"]
mod provider_gate;
#[path = "codex_prompt_queue/scenarios.rs"]
mod scenarios;

use cadencr_service::domain::ws_session::protocol::WsEnvelope;
use cadencr_service::shared::app_paths;
use common::TEST_AUTH_TOKEN;
use futures::{SinkExt, StreamExt};
use provider_gate::ProviderGate;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
struct Harness {
    base: String,
    client: reqwest::Client,
    pool: sqlx::SqlitePool,
    repo: PathBuf,
    _tmp_dir: tempfile::TempDir,
}
impl Harness {
    async fn new() -> Self {
        let server = common::start_migrated_test_server().await;
        let repo = server.repo_path();
        let common::TestServer {
            base_url,
            client,
            pool,
            tmp_dir,
        } = server;
        Self {
            base: base_url,
            client,
            pool,
            repo,
            _tmp_dir: tmp_dir,
        }
    }
    async fn session(&self, resumed: bool) -> (Socket, i64) {
        let feature: Value = self
            .client
            .post(format!("{}/api/features", self.base))
            .json(&json!({"project_id":1,"title":"Codex queue QA","worktree_mode":"skip"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        if resumed {
            sqlx::query("INSERT INTO agent_sessions (feature_id,agent_type,status,runtime_provider,runtime_session_id,model) VALUES (?,'session','paused','codex_cli',?,'qa-model')")
                .bind(feature["id"].as_i64().unwrap()).bind(uuid::Uuid::new_v4().to_string())
                .execute(&self.pool).await.unwrap();
        }
        let mut req = format!("{}/ws", self.base.replace("http://", "ws://"))
            .into_client_request()
            .unwrap();
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("cadencr-token.{TEST_AUTH_TOKEN}")).unwrap(),
        );
        let mut socket = tokio_tungstenite::connect_async(req).await.unwrap().0;
        send(&mut socket, "init", json!({"feature_id":feature["id"],"provider":"codex_cli","model":"qa-model","cwd":self.repo})).await;
        let initialized = until(&mut socket, "initialized").await;
        (
            socket,
            initialized["payload"]["session_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        )
    }
    async fn enqueue(&self, session: i64, text: &str) -> i64 {
        let p: Value = self
            .client
            .post(format!("{}/api/sessions/{session}/prompt-queue", self.base))
            .json(&json!({"content":text}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        p["id"].as_i64().unwrap()
    }
    async fn queue(&self, session: i64) -> Vec<Value> {
        self.client
            .get(format!("{}/api/sessions/{session}/prompt-queue", self.base))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn state(&self, id: i64) -> String {
        sqlx::query_scalar("SELECT status FROM agent_session_prompt_queue WHERE id=?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    async fn wait_empty(&self, session: i64) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let queue = self.queue(session).await;
                assert!(!queue.iter().any(|p| p["status"] == "error"), "{queue:?}");
                if queue.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("queue should drain");
    }
    /// Wait for the session's turn to end. A fixed pause raced the turn under
    /// load: a prompt enqueued while it still ran stays pending instead of
    /// being delivered at once.
    async fn wait_idle(&self, session: i64) {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let status: String =
                    sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id=?")
                        .bind(session)
                        .fetch_one(&self.pool)
                        .await
                        .unwrap();
                if status != "running" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the turn should end");
    }
    /// The item's status once delivery settled: the service can still be
    /// finishing the previous turn when the item is enqueued.
    async fn settled_state(&self, id: i64) -> String {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let state = self.state(id).await;
                if state != "pending" && state != "delivering" {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the queued prompt should be delivered or rejected")
    }
    async fn user_messages(&self, session: i64) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT content FROM agent_messages WHERE session_id=? AND role='user' ORDER BY id",
        )
        .bind(session)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}
async fn send(socket: &mut Socket, action: &str, payload: Value) {
    socket
        .send(Message::Text(
            String::from(WsEnvelope::new("session", action, payload)).into(),
        ))
        .await
        .unwrap();
}
async fn prompt(socket: &mut Socket, session: i64, text: &str) {
    send(
        socket,
        "prompt.send",
        json!({"session_id":session.to_string(),"text":text,"message_uuid":uuid::Uuid::new_v4().to_string()}),
    )
    .await;
}
async fn until(socket: &mut Socket, action: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let msg = socket.next().await.unwrap().unwrap();
            if let Message::Text(text) = msg {
                let event: Value = serde_json::from_str(&text).unwrap();
                assert_ne!(event["action"], "error", "{event}");
                if event["action"] == action {
                    return event;
                }
            }
        }
    })
    .await
    .expect(action)
}

#[tokio::test]
async fn codex_queue_and_steering_survive_compaction_and_normal_turns() {
    let data = tempfile::tempdir().unwrap();
    app_paths::pin_roots(Some(data.path())).unwrap();
    cadencr_service::domain::settings_store::init(app_paths::settings_dir().unwrap());
    codex_app_server_sdk_rs::set_binary_override(Some(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_queue.py")
            .canonicalize()
            .unwrap(),
    ));
    let h = Harness::new().await;
    for resumed in [true, false] {
        let (mut socket, session) = h.session(resumed).await;
        if !resumed {
            prompt(&mut socket, session, "warmup").await;
            until(&mut socket, "ended").await;
        }
        let completion = ProviderGate::arm(&h.repo, "compact-turn-completion");
        send(
            &mut socket,
            "compact",
            json!({"session_id":session.to_string(),"message_uuid":uuid::Uuid::new_v4().to_string()}),
        )
        .await;
        until(&mut socket, "compact.started").await;
        completion.wait().await;
        let first = h.enqueue(session, "first queued").await;
        prompt(&mut socket, session, "steer during compact").await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.queue(session).await.len() < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let second = h.enqueue(session, "last queued").await;
        h.client
            .post(format!(
                "{}/api/sessions/{session}/prompt-queue/{first}/send",
                h.base
            ))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(h.state(first).await, "pending");
        assert_eq!(h.state(second).await, "pending");
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id=?")
            .bind(session)
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(status, "running");
        completion.release();
        h.wait_empty(session).await;
        let messages = h.user_messages(session).await;
        assert!(
            messages.ends_with(&[
                "/compact".into(),
                "first queued".into(),
                "steer during compact".into(),
                "last queued".into()
            ]),
            "{messages:?}"
        );
        let errors: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id=? AND message_type='error'",
        )
        .bind(session)
        .fetch_one(&h.pool)
        .await
        .unwrap();
        assert_eq!(errors, 0);
        socket.close(None).await.unwrap();
    }
    let (mut socket, session) = h.session(false).await;
    let completion = ProviderGate::arm(&h.repo, "held-turn-completion");
    prompt(&mut socket, session, "hold").await;
    until(&mut socket, "user_message").await;
    // Wait for the fixture's first provider event, not just local persistence.
    until(&mut socket, "runtime_session_id").await;
    completion.wait().await;
    let a = h.enqueue(session, "normal A").await;
    let b = h.enqueue(session, "normal B").await;
    let steer = ProviderGate::arm(&h.repo, "steer-reply");
    prompt(&mut socket, session, "normal steer").await;
    steer.wait().await;
    assert_eq!(h.state(a).await, "pending");
    assert_eq!(h.state(b).await, "pending");
    steer.release();
    completion.release();
    h.wait_empty(session).await;
    assert_eq!(
        h.user_messages(session).await,
        ["hold", "normal steer", "normal A", "normal B"]
    );
    // An owner stays connected after its turn; that must not strand a queue.
    h.wait_idle(session).await;
    let idle = h.enqueue(session, "queued while idle").await;
    h.wait_empty(session).await;
    assert_eq!(h.state(idle).await, "delivered");
    h.wait_idle(session).await;
    let rejected = h.enqueue(session, "reject").await;
    assert_eq!(h.settled_state(rejected).await, "error");
    assert!(h.queue(session).await[0]["error"]
        .as_str()
        .unwrap()
        .contains("QUEUE_DELIVERY_REJECTED"));
    h.client
        .post(format!(
            "{}/api/sessions/{session}/prompt-queue/{rejected}/send",
            h.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(
        h.user_messages(session)
            .await
            .iter()
            .filter(|m| *m == "reject")
            .count(),
        1
    );
    h.client
        .patch(format!(
            "{}/api/sessions/{session}/prompt-queue/{rejected}",
            h.base
        ))
        .json(&json!({"content":"fixed"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    h.client
        .post(format!(
            "{}/api/sessions/{session}/prompt-queue/{rejected}/send",
            h.base
        ))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(h.state(rejected).await, "delivered");
    socket.close(None).await.unwrap();
    // First-send failures must also remain visible; they used to return Ok.
    let (_socket, fresh) = h.session(false).await;
    let rejected = h.enqueue(fresh, "reject").await;
    assert_eq!(h.state(rejected).await, "error");
    assert!(h.queue(fresh).await[0]["error"]
        .as_str()
        .unwrap()
        .contains("QUEUE_DELIVERY_REJECTED"));

    let (mut socket, running) = h.session(false).await;
    let completion = ProviderGate::arm(&h.repo, "held-turn-completion");
    prompt(&mut socket, running, "hold").await;
    until(&mut socket, "runtime_session_id").await;
    completion.wait().await;
    let rejected = h.enqueue(running, "reject").await;
    let response = h
        .client
        .post(format!(
            "{}/api/sessions/{running}/prompt-queue/{rejected}/send",
            h.base
        ))
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    assert_eq!(h.state(rejected).await, "error");
    let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id=?")
        .bind(running)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(
        status, "running",
        "a rejected steer must not stop the existing turn"
    );
    completion.release();
    h.client
        .delete(format!(
            "{}/api/sessions/{running}/prompt-queue/{rejected}",
            h.base
        ))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let last = h.enqueue(running, "after rejected steer").await;
    h.wait_empty(running).await;
    assert_eq!(h.state(last).await, "delivered");

    scenarios::completed_turn_with_late_ack_drains_queue(&h).await;
    scenarios::deferred_retransmissions_run_once(&h).await;
    scenarios::queue_waits_for_compaction_initialization(&h).await;
    scenarios::completed_compaction_with_late_ack_drains_queue(&h).await;
}
