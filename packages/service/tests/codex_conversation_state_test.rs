//! Deterministic subprocess -> adapter -> WS -> persistence regression replay.
//! No real Codex/model/subagents and no existing database are used.
//!
//! Own test binary: it calls `settings_store::init` (a first-call-wins
//! `OnceLock`) and installs a process-global Codex binary override.
mod common;

use std::path::Path;
use std::time::Duration;

use cadencr_service::domain::ws_session::protocol::WsEnvelope;
use common::{start_migrated_test_server, TEST_AUTH_TOKEN};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx::Row;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{http::HeaderValue, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(base: &str) -> Socket {
    let mut request = format!("{}/ws", base.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("cadencr-token.{TEST_AUTH_TOKEN}")).unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn send(socket: &mut Socket, domain: &str, action: &str, payload: Value) {
    let envelope = WsEnvelope::new(domain, action, payload);
    socket
        .send(Message::Text(String::from(envelope).into()))
        .await
        .unwrap();
}

async fn next(socket: &mut Socket) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        match tokio::time::timeout_at(deadline, socket.next())
            .await
            .expect("WS timeout")
            .expect("WS closed")
            .unwrap()
        {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            Message::Close(frame) => panic!("unexpected close: {frame:?}"),
            _ => {}
        }
    }
}

async fn snapshot(base: &str, session: &str, active: bool) {
    let mut observer = connect(base).await;
    send(&mut observer, "app", "subscribe.session_status", json!({})).await;
    let value = next(&mut observer).await;
    assert_eq!(value["action"], "session_status.snapshot");
    let status = &value["payload"]["states"][session]["status"];
    if active {
        assert_eq!(status, "agent");
    } else {
        assert!(status.is_null() || status == "idle");
    }
    observer.close(None).await.unwrap();
}

#[tokio::test]
async fn codex_conversation_routing_and_completion_survive_messaging() {
    let settings = tempfile::tempdir().unwrap().keep();
    cadencr_service::domain::settings_store::init(settings);
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake_codex_conversation.py")
        .canonicalize()
        .unwrap();
    codex_app_server_sdk_rs::set_binary_override(Some(fixture));
    let server = start_migrated_test_server().await;
    let repo = server.repo_path();
    // Preserve the test DB as well: never remove a Cadencr database on cleanup.
    let artifacts = server.tmp_dir.keep();
    eprintln!("Codex regression artifacts: {}", artifacts.display());

    for mode in [
        "legacy",
        "large-history",
        "upward",
        "sibling",
        "resumed",
        "stop-status",
        "read-failure",
        "foreign",
        "summary",
        "burst",
        "read-timeout",
        "missing-parent",
        "conflicting-parent",
        "close-error",
        "close-timeout",
    ] {
        let feature: Value = server
            .client
            .post(format!("{}/api/features", server.base_url))
            .json(&json!({"project_id":1,"title":mode,"worktree_mode":"skip"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        if mode == "large-history" {
            let session_id: i64 = sqlx::query_scalar(
                "INSERT INTO agent_sessions (feature_id,agent_type,status,runtime_provider,runtime_session_id,model) \
                 VALUES (?,'session','paused','codex_cli','11111111-1111-4111-8111-111111111111','qa-model') RETURNING id",
            )
            .bind(feature["id"].as_i64().unwrap())
            .fetch_one(&server.pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO agent_messages (session_id,role,message_type,content) VALUES (?,'assistant','text','PERSISTED_BEFORE_RESUME')")
                .bind(session_id).execute(&server.pool).await.unwrap();
        }
        let mut socket = connect(&server.base_url).await;
        send(&mut socket, "app", "subscribe.session_status", json!({})).await;
        send(
            &mut socket,
            "session",
            "init",
            json!({"feature_id":feature["id"],
            "provider":"codex_cli","model":"qa-model","cwd":repo}),
        )
        .await;
        let session = loop {
            let event = next(&mut socket).await;
            assert_ne!(event["action"], "error", "{event}");
            if event["action"] == "initialized" {
                break event["payload"]["session_id"].as_str().unwrap().to_string();
            }
        };
        send(
            &mut socket,
            "session",
            "prompt.send",
            json!({"session_id":session,
            "text":mode,"message_uuid":uuid::Uuid::new_v4().to_string()}),
        )
        .await;
        let events = tokio::time::timeout(Duration::from_secs(30), async {
            let mut events = Vec::new();
            let mut ended = false;
            let mut checked_children = false;
            loop {
                let event = next(&mut socket).await;
                let is_final = event["action"] == "message"
                    && event["payload"]
                        .to_string()
                        .contains(&format!("ROOT_FINAL_{mode}"));
                if is_final
                    && !checked_children
                    && matches!(mode, "upward" | "sibling" | "resumed" | "stop-status")
                {
                    assert!(!ended, "root ended before its real child: {mode}");
                    snapshot(&server.base_url, &session, true).await;
                    checked_children = true;
                    if mode == "stop-status" {
                        send(
                            &mut socket,
                            "session",
                            "interrupt",
                            json!({"session_id":session}),
                        )
                        .await;
                    }
                }
                ended |= event["action"] == "ended";
                let idle = ended
                    && event["action"] == "session_status.update"
                    && event["payload"]["status"] == "idle";
                events.push(event);
                if idle {
                    break events;
                }
            }
        })
        .await
        .expect(mode);
        assert_eq!(events.iter().filter(|e| e["action"] == "ended").count(), 1);
        assert!(events
            .iter()
            .any(|e| e["action"] == "session_status.update" && e["payload"]["status"] == "agent"));
        let errors: Vec<_> = events.iter().filter(|e| e["action"] == "error").collect();
        if mode == "read-failure" {
            assert!(errors
                .iter()
                .any(|e| e.to_string().contains("METADATA_READ_FAILED")));
        } else if matches!(
            mode,
            "read-timeout" | "missing-parent" | "conflicting-parent"
        ) {
            assert!(
                errors
                    .iter()
                    .any(|e| e.to_string().contains("CODEX_SUBAGENT_LINEAGE")),
                "{mode}: {errors:?}"
            );
        } else {
            assert!(errors.is_empty(), "{mode}: {errors:?}");
        }
        snapshot(&server.base_url, &session, false).await;
        let rows = sqlx::query("SELECT content,parent_tool_use_id FROM agent_messages WHERE session_id=? AND message_type='text' ORDER BY id")
            .bind(session.parse::<i64>().unwrap()).fetch_all(&server.pool).await.unwrap();
        assert!(rows.iter().any(|r| r
            .get::<String, _>("content")
            .contains(&format!("ROOT_FINAL_{mode}"))));
        if matches!(mode, "upward" | "sibling" | "resumed") {
            assert!(rows
                .iter()
                .any(|r| r.get::<String, _>("content") == "CHILD_FINAL"));
        }
        if mode == "burst" {
            let burst = rows
                .iter()
                .map(|r| r.get::<String, _>("content"))
                .find(|content| content.starts_with("BURST_"))
                .expect("burst content persisted");
            let expected: String = (0..1_600).map(|n| format!("BURST_{n},")).collect();
            assert_eq!(
                burst, expected,
                "no deltas may be lost during metadata lookup"
            );
            assert!(rows
                .iter()
                .any(|r| r.get::<String, _>("content") == "CHILD_FINAL"));
        }
        if mode == "sibling" {
            let parent = sqlx::query_scalar::<_, Option<String>>(
                "SELECT card.parent_tool_use_id FROM agent_messages text JOIN agent_messages card \
                 ON card.session_id=text.session_id AND card.tool_use_id=text.parent_tool_use_id \
                 WHERE text.session_id=? AND text.content='SIBLING_FINAL' AND card.message_type='tool_call'",
            ).bind(session.parse::<i64>().unwrap()).fetch_one(&server.pool).await.unwrap();
            assert!(
                parent.is_none(),
                "a sibling must not be nested under its sender"
            );
        }
        for row in &rows {
            let content: String = row.get("content");
            let parent: Option<String> = row.get("parent_tool_use_id");
            if content.starts_with("ROOT_") {
                assert!(parent.is_none(), "misnested {content}");
            }
            if content == "CHILD_FINAL" || content == "SIBLING_FINAL" {
                assert!(parent.is_some());
            }
        }
        let hydration: Value = server
            .client
            .get(format!(
                "{}/api/features/{}/agent-state",
                server.base_url, feature["id"]
            ))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(hydration
            .to_string()
            .contains(&format!("ROOT_FINAL_{mode}")));
        if mode == "large-history" {
            assert!(hydration.to_string().contains("PERSISTED_BEFORE_RESUME"));
            let runtime_id: String =
                sqlx::query_scalar("SELECT runtime_session_id FROM agent_sessions WHERE id=?")
                    .bind(session.parse::<i64>().unwrap())
                    .fetch_one(&server.pool)
                    .await
                    .unwrap();
            assert_eq!(runtime_id, "11111111-1111-4111-8111-111111111111");
        }
        if mode == "upward" {
            send(
                &mut socket,
                "session",
                "prompt.send",
                json!({"session_id":session,
                "text":"legacy","message_uuid":uuid::Uuid::new_v4().to_string()}),
            )
            .await;
            loop {
                if next(&mut socket).await["action"] == "ended" {
                    break;
                }
            }
            let parent = sqlx::query_scalar::<_, Option<String>>(
                "SELECT parent_tool_use_id FROM agent_messages WHERE session_id=? AND content='ROOT_FINAL_legacy_2'",
            ).bind(session.parse::<i64>().unwrap()).fetch_one(&server.pool).await.unwrap();
            assert!(parent.is_none(), "later root turns stay at the root");
        }
        if matches!(mode, "close-error" | "close-timeout") {
            let started = tokio::time::Instant::now();
            send(
                &mut socket,
                "session",
                "destroy",
                json!({"session_id":session}),
            )
            .await;
            let mut reported = false;
            let mut destroyed = false;
            while !reported || !destroyed {
                let event = next(&mut socket).await;
                if event["action"] == "error" {
                    let message = event["payload"]["message"].as_str().unwrap();
                    assert!(message.contains("thread/unsubscribe failed"), "{event}");
                    assert!(
                        message.contains(if mode == "close-error" {
                            "UNSUBSCRIBE_FAILED"
                        } else {
                            "timed out"
                        }),
                        "{event}"
                    );
                    reported = true;
                }
                destroyed |=
                    event["action"] == "ended" && event["payload"]["reason"] == "destroyed";
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "close remains bounded"
            );
            let messages: Vec<String> = sqlx::query_scalar(
                "SELECT content FROM agent_messages WHERE session_id=? AND message_type='error'",
            )
            .bind(session.parse::<i64>().unwrap())
            .fetch_all(&server.pool)
            .await
            .unwrap();
            assert!(messages
                .iter()
                .any(|text| text.contains("thread/unsubscribe failed")));
        }
        socket.close(None).await.unwrap();
    }
}
