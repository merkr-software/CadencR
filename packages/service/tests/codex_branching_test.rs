//! Codex forks and rewinds through the real adapter and an app-server
//! subprocess (`tests/fixtures/fake_codex_branching.py`). Own test binary:
//! the Codex binary override and `settings_store::init` are process-wide.

use std::path::{Path, PathBuf};

use cadencr_service::domain::agents::adapter::{BranchContext, BranchError, BranchResult};
use cadencr_service::domain::agents::providers::provider_registry;

/// A working directory where the fixture plays the app-server `mode`.
fn app_server_dir(mode: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("fixture-mode"), mode).unwrap();
    dir
}

/// Branch the fixture's three-turn source thread before its second prompt.
async fn cut_before_second_prompt(cwd: &Path) -> Result<BranchResult, BranchError> {
    let adapter = provider_registry()
        .adapter("codex_cli")
        .expect("Codex adapter");
    let branching = adapter.session_branching().expect("Codex branches");
    branching
        .truncate_before(&BranchContext {
            cwd: cwd.canonicalize().unwrap(),
            profile: None,
            source_runtime_session_id: "source-thread".to_string(),
            cut_provider_uuid: None,
            cut_user_ordinal: 2,
        })
        .await
}

/// The requests the app-server received, as `method` or `method params`.
fn requests(cwd: &Path) -> Vec<String> {
    std::fs::read_to_string(cwd.join("requests.log"))
        .unwrap()
        .lines()
        .map(|line| {
            let request: serde_json::Value = serde_json::from_str(line).unwrap();
            let method = request["method"].as_str().unwrap();
            match method {
                "thread/revert" => format!("{method} {}", request["params"]["beforeTurnId"]),
                "thread/rollback" => format!("{method} {}", request["params"]["numTurns"]),
                _ => method.to_string(),
            }
        })
        .collect()
}

/// Found in QA: Codex 0.167 dropped `thread/rollback` (it answers
/// `-32600 unknown variant`), so every fork or rewind that needed a cut
/// failed. It cuts with `thread/revert`; older app-servers only know
/// rollback, and a cut the app-server did not apply is never handed on.
#[tokio::test]
async fn codex_cuts_a_fork_with_whichever_method_its_app_server_knows() {
    let settings = tempfile::tempdir().unwrap();
    cadencr_service::domain::settings_store::init(settings.path().to_path_buf());
    let fixture: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake_codex_branching.py")
        .canonicalize()
        .unwrap();
    codex_app_server_sdk_rs::set_binary_override(Some(fixture));

    let current = app_server_dir("revert");
    let branched = cut_before_second_prompt(current.path()).await;
    assert_eq!(
        branched.expect("0.167 cut").new_runtime_session_id,
        "fork-1"
    );
    // After the profile probe's requests: read, fork, cut, check the cut.
    let sent = requests(current.path());
    assert!(
        sent.ends_with(&[
            "initialize".to_string(),
            "thread/read".to_string(),
            "thread/fork".to_string(),
            "thread/revert \"turn-1\"".to_string(),
            "thread/read".to_string(),
        ]),
        "{sent:?}"
    );

    let legacy = app_server_dir("rollback");
    let branched = cut_before_second_prompt(legacy.path()).await;
    assert_eq!(
        branched.expect("legacy cut").new_runtime_session_id,
        "fork-1"
    );
    assert!(
        requests(legacy.path()).contains(&"thread/rollback 2".to_string()),
        "{:?}",
        requests(legacy.path())
    );

    let ignored = app_server_dir("ignore-cut");
    let error = cut_before_second_prompt(ignored.path()).await.unwrap_err();
    assert!(
        matches!(&error, BranchError::Surgery(message) if message.contains("kept 3 turns")),
        "{error}"
    );
    // The uncut fork, which holds the whole history, does not stay listed.
    assert!(
        requests(ignored.path()).ends_with(&["thread/archive".to_string()]),
        "{:?}",
        requests(ignored.path())
    );
}
