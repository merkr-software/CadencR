#![cfg(unix)]

use std::fs;
use std::io::Write;
use std::time::Duration;

use codex_app_server_sdk_rs::{
    set_binary_override, AppServerClientInfo, AppServerSpawnOptions, CodexAppServerClient, SdkError,
};
use tempfile::TempDir;

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct BinaryOverrideGuard;

impl BinaryOverrideGuard {
    fn set(path: std::path::PathBuf) -> Self {
        set_binary_override(Some(path));
        Self
    }
}

impl Drop for BinaryOverrideGuard {
    fn drop(&mut self) {
        set_binary_override(None);
    }
}

fn write_executable(script: &[u8]) -> (TempDir, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("codex");
    let mut file = fs::File::create(&path).expect("mock codex file");
    file.write_all(script).expect("write mock codex");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("chmod");
    (temp, path)
}

fn write_mock_codex() -> (TempDir, std::path::PathBuf) {
    write_executable(
        br#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.0.0"
  exit 0
fi
if [ "$1" != "app-server" ]; then
  echo "unexpected args: $*" >&2
  exit 2
fi
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      echo '{"id":1,"result":{"server":"ok"}}'
      ;;
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"gpt-test","displayName":"GPT Test","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}],"nextCursor":null}}'
      ;;
    *'"method":"thread/start"'*)
      echo '{"id":3,"result":{"threadId":"thread_mock"}}'
      ;;
    *'"method":"turn/start"'*)
      echo '{"id":4,"result":{"turn":{"id":"turn_mock"}}}'
      ;;
    *'"method":"thread/fork"'*)
      echo '{"id":5,"result":{"thread":{"id":"thread_fork","turns":[{"id":"turn_1","status":"completed","items":[{"type":"userMessage","id":"user_1","content":[{"type":"text","text":"first"}]}]},{"id":"turn_2","status":"completed","items":[{"type":"userMessage","id":"user_2","content":[{"type":"text","text":"second"}]}]}]}}}'
      ;;
    *'"method":"thread/rollback"'*)
      echo '{"id":6,"result":{"thread":{"id":"thread_fork","turns":[{"id":"turn_1","status":"completed","items":[{"type":"userMessage","id":"user_1","content":[{"type":"text","text":"first"}]}]}]}}}'
      ;;
    *'"method":"thread/read"'*)
      echo '{"id":7,"result":{"thread":{"id":"thread_fork","turns":[{"id":"turn_1","status":"completed","items":[{"type":"userMessage","id":"user_1","content":[{"type":"text","text":"first"}]}]}]}}}'
      ;;
  esac
done
"#,
    )
}

fn write_silent_codex() -> (TempDir, std::path::PathBuf) {
    write_executable(
        b"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo codex-cli 0.0.0; exit 0; fi\nsleep 5\n",
    )
}

#[tokio::test]
async fn mock_app_server_lifecycle_supports_handshake_model_list_and_requests() {
    let _guard = TEST_LOCK.lock().await;
    let (_temp, path) = write_mock_codex();
    let _override = BinaryOverrideGuard::set(path);

    let client = CodexAppServerClient::spawn_with_options(AppServerSpawnOptions {
        client_info: AppServerClientInfo {
            name: "cadencr-test".to_string(),
            title: "Cadencr Test".to_string(),
            version: "0.0.0".to_string(),
        },
        request_timeout: Some(Duration::from_secs(2)),
        ..Default::default()
    })
    .await
    .expect("spawn mock app-server");

    assert_eq!(client.initialize().await.unwrap()["server"], "ok");
    let models = client.model_list().await.unwrap();
    assert_eq!(models[0].id, "gpt-test");
    assert_eq!(models[0].supported_efforts, vec!["low", "high"]);
    assert_eq!(
        client
            .thread_start(serde_json::json!({ "cwd": "/tmp" }))
            .await
            .unwrap()
            .id,
        "thread_mock"
    );
    assert_eq!(
        client
            .turn_start(serde_json::json!({ "threadId": "thread_mock", "input": [] }))
            .await
            .unwrap()
            .id,
        "turn_mock"
    );
    let forked = client
        .thread_fork("thread_mock", std::path::Path::new("/tmp"))
        .await
        .unwrap();
    assert_eq!(forked.id, "thread_fork");
    assert_eq!(forked.turns.len(), 2);
    assert_eq!(forked.turns[1].user_message_count(), 1);

    client.thread_rollback("thread_fork", 1).await.unwrap();

    let read = client.thread_read("thread_fork", true).await.unwrap();
    assert_eq!(read.id, "thread_fork");
    assert_eq!(read.turns.len(), 1);

    client.shutdown().await;
    client.shutdown().await;
}

#[tokio::test]
async fn request_with_timeout_returns_timeout_for_silent_server() {
    let _guard = TEST_LOCK.lock().await;
    let (_temp, path) = write_silent_codex();
    let _override = BinaryOverrideGuard::set(path);

    let client = CodexAppServerClient::spawn_with_options(AppServerSpawnOptions {
        request_timeout: Some(Duration::from_millis(25)),
        ..Default::default()
    })
    .await
    .expect("spawn silent mock app-server");

    let error = client
        .request_with_timeout(
            "model/list",
            serde_json::json!({}),
            Duration::from_millis(25),
        )
        .await
        .expect_err("silent app-server should time out");
    assert!(matches!(error, SdkError::Timeout("request")));
    client.shutdown().await;
}
