//! Stopping a Codex turn through the real adapter and an app-server
//! subprocess that behaves like Codex 0.167 (`tests/fixtures/fake_codex_stop.py`).
//! Own test binary: the Codex binary override and `settings_store::init` are
//! process-wide.

#[path = "common/provider_gate.rs"]
mod provider_gate;

use std::path::Path;
use std::time::Duration;

use cadencr_service::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimeSpawnConfig,
};
use cadencr_service::domain::agents::providers::provider_registry;
use cadencr_service::shared::app_paths;
use provider_gate::ProviderGate;
use serde_json::json;

/// A Codex runtime whose first turn was sent `prompt`, with its stream.
async fn codex(cwd: &Path, prompt: &str) -> (Box<dyn AgentRuntimeSession>, RuntimeMessageRx) {
    let mut session = provider_registry()
        .adapter("codex_cli")
        .expect("Codex adapter")
        .spawn(
            json!(prompt),
            RuntimeSpawnConfig {
                cwd: cwd.to_path_buf(),
                model: Some("qa-model".to_string()),
                ..RuntimeSpawnConfig::default()
            },
        )
        .await
        .expect("Codex spawn");
    let stream = session.take_message_rx();
    (session, stream)
}

/// Read the stream until an event whose raw JSON contains `needle`.
async fn wait_for(stream: &mut RuntimeMessageRx, needle: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = stream.recv().await.expect("stream open").expect("no error");
            if event.raw_json().to_string().contains(needle) {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no event with {needle}"));
}

async fn wait_for_result(stream: &mut RuntimeMessageRx) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !stream.recv().await.unwrap().unwrap().is_result() {}
    })
    .await
    .expect("the turn ends");
}

/// Request methods the app-server got, with the process of a terminate.
fn requests(cwd: &Path) -> Vec<String> {
    std::fs::read_to_string(cwd.join("requests.log"))
        .unwrap()
        .lines()
        .map(|line| {
            let request: serde_json::Value = serde_json::from_str(line).unwrap();
            let method = request["method"].as_str().unwrap().to_string();
            let detail = request["params"]["processId"]
                .as_str()
                .or(request["params"]["turnId"]
                    .as_str()
                    .filter(|_| method == "turn/interrupt"));
            match detail {
                Some(detail) => format!("{method} {detail}"),
                None => method,
            }
        })
        .collect()
}

/// Point the process at the fixture, once for every test of this binary.
fn use_fixture() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let data = tempfile::tempdir().unwrap().keep();
        app_paths::pin_roots(Some(&data)).unwrap();
        cadencr_service::domain::settings_store::init(app_paths::settings_dir().unwrap());
        codex_app_server_sdk_rs::set_binary_override(Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fake_codex_stop.py")
                .canonicalize()
                .unwrap(),
        ));
    });
}

/// Found in QA: Stop showed "Stopped by you" while the turn's foreground
/// script went on running. Codex 0.167 keeps a command past
/// `turn/interrupt` (a background terminal); Stop must end it.
#[tokio::test]
async fn stopping_a_codex_turn_ends_the_commands_it_started() {
    use_fixture();
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();
    let (session, mut stream) = codex(&cwd, "command").await;
    wait_for(&mut stream, "COMMAND_RUNNING").await;

    session.interrupt().await.expect("stop");

    let sent = requests(&cwd);
    let interrupt = sent
        .iter()
        .position(|method| method == "turn/interrupt turn-1");
    let terminate = sent
        .iter()
        .position(|method| method == "thread/backgroundTerminals/terminate process-1");
    assert!(
        matches!((interrupt, terminate), (Some(i), Some(t)) if i < t),
        "{sent:?}"
    );
}

/// A Stop that reaches an idle Codex (its turn ended a moment before) used
/// to report success: Codex refuses to interrupt a turn that ended, but the
/// adapter ignored that refusal. The host kept its stop mark, and the next
/// turn's result was taken for the stopped turn's and dropped, leaving the
/// session "running". It must say nothing was running.
#[tokio::test]
async fn a_stop_on_an_idle_codex_says_nothing_was_running() {
    use_fixture();
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();
    let (session, mut stream) = codex(&cwd, "reply").await;
    wait_for_result(&mut stream).await;

    let error = session.interrupt().await.unwrap_err();

    assert!(
        matches!(error, RuntimeError::NothingToInterrupt),
        "{error:?}"
    );
    assert!(requests(&cwd).contains(&"turn/interrupt turn-1".to_string()));
}

/// Only Codex's "no active turn to interrupt" means nothing ran: another
/// failure (here an internal error) is still reported as a failed Stop.
#[tokio::test]
async fn a_failed_interrupt_is_not_taken_for_an_idle_codex() {
    use_fixture();
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();
    let (session, mut stream) = codex(&cwd, "broken-interrupt").await;
    wait_for_result(&mut stream).await;

    let error = session.interrupt().await.unwrap_err();

    assert!(!error.is_nothing_to_interrupt(), "{error:?}");
    assert!(error.to_string().contains("interrupt failed"), "{error}");
}

/// A Stop sent while `turn/start` has not answered yet used to target the
/// previous turn, which Codex refuses, and the new turn ran on. It waits for
/// the new turn's id and stops that turn.
#[tokio::test]
async fn a_stop_during_a_turn_start_stops_the_starting_turn() {
    use_fixture();
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();
    let (session, mut stream) = codex(&cwd, "reply").await;
    wait_for_result(&mut stream).await;

    let start_reply = ProviderGate::arm(&cwd, "turn-start-reply");
    let (started, stopped) = tokio::join!(session.stream_input(json!("command")), async {
        start_reply.wait().await;
        let mut stop = std::pin::pin!(session.interrupt());
        // Enter the real interrupt path while turn/start is still unanswered.
        assert!(futures::poll!(stop.as_mut()).is_pending());
        start_reply.release();
        stop.await
    });

    started.expect("the turn starts");
    stopped.expect("the starting turn is stopped");
    let sent = requests(&cwd);
    assert!(
        sent.contains(&"turn/interrupt turn-2".to_string()),
        "{sent:?}"
    );
    assert!(
        !sent.contains(&"turn/interrupt turn-1".to_string()),
        "{sent:?}"
    );
}
