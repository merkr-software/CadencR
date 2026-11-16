//! End-to-end proof of the optional `slash-commands` provider package command
//! (`docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md#slash-commands-command`) through
//! the real `/api/prompt-commands` route: a valid listing (cached per
//! directory, refreshed by a live `available_commands_update`), output the
//! host rejects and a reported failure (both surfaced as `error`), and a
//! package without the command (served from the last live snapshot).
//!
//! The agent is `tests/fixtures/fake_acp_agent.py`. Own test binary:
//! `settings_store::init` is first-call-wins and `provider_registry()` scans
//! the providers directory once per process.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use cadencr_service::domain::agents::adapter::{AgentRuntimeSession, RuntimeSpawnConfig};
use cadencr_service::domain::agents::providers::provider_registry;
use common::{start_migrated_test_server, TestServer};
use serde_json::{json, Value};

const LISTING_ID: &str = "fake-slash-acp-agent";
const INVALID_ID: &str = "fake-slash-invalid-acp-agent";
const FAILING_ID: &str = "fake-slash-failing-acp-agent";
const LEGACY_ID: &str = "fake-slash-legacy-acp-agent";
const LIVE_TIMEOUT: Duration = Duration::from_secs(10);

fn fixture_agent() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake_acp_agent.py")
        .canonicalize()
        .expect("fake ACP agent fixture should exist")
}

fn write_descriptor(dir: &Path, id: &str, args: &[&str]) {
    let descriptor = json!({
        "schema_version": 1,
        "agent": {
            "id": id,
            "name": "Fake Slash Agent",
            "version": "1.0.0",
            "description": "Deterministic ACP v1 agent used in tests",
        },
        "installation": {
            "executable": { "command": fixture_agent().to_string_lossy(), "args": args },
        },
    });
    std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_string_pretty(&descriptor).unwrap(),
    )
    .expect("descriptor should be writable");
}

async fn prompt_commands(server: &TestServer, provider: &str, cwd: &str) -> Value {
    let response = server
        .client
        .get(format!("{}/api/prompt-commands", server.base_url))
        .query(&[("cwd", cwd), ("provider", provider)])
        .send()
        .await
        .expect("prompt-commands request");
    assert_eq!(response.status(), 200);
    response.json().await.expect("prompt-commands JSON")
}

/// Provider entries only: Cadencr's own `/cadencr:*` skills are always there.
fn provider_commands(body: &Value) -> Vec<(String, String)> {
    body["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .filter(|command| command["kind"] != "cadencr")
        .map(|command| {
            (
                command["name"].as_str().unwrap().to_string(),
                command["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn names(body: &Value) -> Vec<String> {
    provider_commands(body)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

fn runs(cwd: &Path) -> usize {
    std::fs::read_to_string(cwd.join(".fake-slash-runs"))
        .map(|runs| runs.lines().count())
        .unwrap_or(0)
}

async fn spawn_session(provider: &str, cwd: &Path) -> Box<dyn AgentRuntimeSession> {
    provider_registry()
        .adapter(provider)
        .expect("installed provider")
        .spawn(
            json!("hello"),
            RuntimeSpawnConfig {
                cwd: cwd.to_path_buf(),
                model: Some("fake-small".to_string()),
                ..RuntimeSpawnConfig::default()
            },
        )
        .await
        .expect("installed provider spawn")
}

/// Poll the route until `name` appears (the live update is asynchronous).
async fn wait_for_command(server: &TestServer, provider: &str, cwd: &str, name: &str) -> Value {
    tokio::time::timeout(LIVE_TIMEOUT, async {
        loop {
            let body = prompt_commands(server, provider, cwd).await;
            if names(&body).iter().any(|listed| listed == name) {
                return body;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("`{name}` never reached the {provider} catalog"))
}

async fn exercise_listing(server: &TestServer) {
    let workspace = tempfile::tempdir().unwrap();
    let cwd_path = workspace.path().canonicalize().unwrap();
    let cwd = cwd_path.to_str().unwrap();

    let body = prompt_commands(server, LISTING_ID, cwd).await;
    assert!(body.get("error").is_none(), "{body}");
    assert_eq!(
        provider_commands(&body),
        [
            ("review".to_string(), "command".to_string()),
            ("deploy".to_string(), "skill".to_string())
        ]
    );
    std::fs::write(cwd_path.join(".fake-commands"), "added\n").unwrap();
    let cached = prompt_commands(server, LISTING_ID, cwd).await;
    assert_eq!(
        names(&cached),
        ["review", "deploy"],
        "served from the cache"
    );
    assert_eq!(runs(&cwd_path), 1);

    // A live `available_commands_update` drops the cached listing: the next
    // read re-runs the package and keeps the live-only entry.
    let mut session = spawn_session(LISTING_ID, &cwd_path).await;
    let refreshed = wait_for_command(server, LISTING_ID, cwd, "server-only").await;
    assert_eq!(
        names(&refreshed),
        ["review", "deploy", "added", "server-only"]
    );
    assert_eq!(runs(&cwd_path), 2);
    session.close().await.unwrap();
}

async fn exercise_errors(server: &TestServer) {
    let workspace = tempfile::tempdir().unwrap();
    let cwd = workspace.path().to_str().unwrap();
    for (provider, expected) in [
        (INVALID_ID, "output was rejected"),
        (FAILING_ID, "fake command directory is unreadable"),
    ] {
        let body = prompt_commands(server, provider, cwd).await;
        let error = body["error"].as_str().unwrap_or_else(|| panic!("{body}"));
        assert!(error.contains(expected), "{provider}: {error}");
        assert!(names(&body).is_empty(), "{provider}: {body}");
        assert!(
            body["commands"]
                .as_array()
                .unwrap()
                .iter()
                .any(|command| command["kind"] == "cadencr"),
            "host commands stay available"
        );
    }
    let relative = prompt_commands(server, LISTING_ID, "relative/dir").await;
    assert!(relative["error"]
        .as_str()
        .is_some_and(|error| error.contains("absolute")));
}

async fn exercise_legacy_snapshot(server: &TestServer) {
    let workspace = tempfile::tempdir().unwrap();
    let cwd_path = workspace.path().canonicalize().unwrap();
    let cwd = cwd_path.to_str().unwrap();

    let before = prompt_commands(server, LEGACY_ID, cwd).await;
    assert!(before.get("error").is_none(), "unsupported is not an error");
    assert!(names(&before).is_empty());

    let mut session = spawn_session(LEGACY_ID, &cwd_path).await;
    let after = wait_for_command(server, LEGACY_ID, cwd, "server-only").await;
    assert_eq!(
        provider_commands(&after),
        [
            ("review".to_string(), "command".to_string()),
            ("deploy".to_string(), "skill".to_string()),
            ("server-only".to_string(), "command".to_string())
        ]
    );
    session.close().await.unwrap();
    // The snapshot outlives the session: the next conversation's menu.
    let later = prompt_commands(server, LEGACY_ID, cwd).await;
    assert_eq!(names(&later), ["review", "deploy", "server-only"]);
}

#[tokio::test]
async fn installed_providers_list_slash_commands_before_a_session() {
    let home = tempfile::tempdir().expect("settings dir");
    let providers = home.path().join("providers");
    std::fs::create_dir_all(&providers).unwrap();
    write_descriptor(
        &providers,
        LISTING_ID,
        &["--slash-commands", "--live-commands"],
    );
    write_descriptor(&providers, INVALID_ID, &["--slash-commands-invalid"]);
    write_descriptor(&providers, FAILING_ID, &["--slash-commands-failing"]);
    write_descriptor(&providers, LEGACY_ID, &["--live-commands"]);
    cadencr_service::domain::settings_store::init(home.path().to_path_buf());

    let server = start_migrated_test_server().await;
    exercise_listing(&server).await;
    exercise_errors(&server).await;
    exercise_legacy_snapshot(&server).await;
}
