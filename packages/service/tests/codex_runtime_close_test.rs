//! Closing a Codex runtime through the real adapter and a Codex app-server
//! subprocess (`tests/fixtures/fake_codex_conversation.py`). Own test binary:
//! the Codex binary override and `settings_store::init` are process-wide.

use std::path::Path;
use std::time::Duration;

use cadencr_service::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeMessageRx, RuntimeSpawnConfig,
};
use cadencr_service::domain::agents::providers::provider_registry;
use serde_json::json;

/// A Codex runtime whose first turn, run in the fixture's `mode`, completed.
async fn idle_codex(cwd: &Path, mode: &str) -> (Box<dyn AgentRuntimeSession>, RuntimeMessageRx) {
    let mut session = provider_registry()
        .adapter("codex_cli")
        .expect("Codex adapter")
        .spawn(
            json!(mode),
            RuntimeSpawnConfig {
                cwd: cwd.to_path_buf(),
                model: Some("qa-model".to_string()),
                ..RuntimeSpawnConfig::default()
            },
        )
        .await
        .expect("Codex spawn");
    let mut stream = session.take_message_rx();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !stream.recv().await.unwrap().unwrap().is_result() {}
    })
    .await
    .expect("the first turn completes");
    (session, stream)
}

async fn assert_stream_ends(stream: &mut RuntimeMessageRx) {
    let end = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match stream.recv().await {
                None => break,
                Some(Err(error)) => panic!("a close is no stream failure: {error}"),
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(end.is_ok(), "the stream ends with the closed runtime");
}

/// Found in QA: the shutdown closed an idle Codex runtime, but its stream
/// stayed open, so its reader lived on and, once the desktop was gone,
/// retired the runtime by closing it again. That second close sent
/// `thread/unsubscribe` to the app-server the first one had stopped, and
/// "Codex session closed, but thread/unsubscribe failed: Broken pipe" was
/// saved in the conversation.
#[tokio::test]
async fn a_closed_codex_runtime_ends_its_stream_and_closes_again_quietly() {
    let settings = tempfile::tempdir().unwrap();
    cadencr_service::domain::settings_store::init(settings.path().to_path_buf());
    codex_app_server_sdk_rs::set_binary_override(Some(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_conversation.py")
            .canonicalize()
            .unwrap(),
    ));
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();

    let (mut session, mut stream) = idle_codex(&cwd, "legacy").await;
    session.close().await.expect("first close");
    session
        .close()
        .await
        .expect("a closed session closes again without asking the stopped app-server");
    assert_stream_ends(&mut stream).await;

    // The shutdown's deadline can drop a close stuck on `thread/unsubscribe`
    // (here, one the app-server never answers): a later close still stops the
    // app-server and ends the stream.
    let (mut session, mut stream) = idle_codex(&cwd, "close-timeout").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), session.close())
            .await
            .is_err(),
        "the unanswered unsubscribe holds the first close"
    );
    session.close().await.expect("the retried close");
    assert_stream_ends(&mut stream).await;
}
