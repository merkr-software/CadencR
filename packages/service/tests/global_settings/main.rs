//! Tests that write the process-global settings file.
//!
//! Settings are process-global, so keep these tests in their own binary.
//! Each test holds the lock and starts with an empty, disposable directory.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::LazyLock;

use cadencr_service::domain::settings_store;

#[path = "../support/mod.rs"]
mod support;

mod mcp_control;
mod spawn_settings;
mod workspace_mcp_activity;
mod workspace_mcp_tools;

static SETTINGS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static SUITE_ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    let path =
        std::env::temp_dir().join(format!("cadencr-global-settings-{}", uuid::Uuid::new_v4()));
    cadencr_service::shared::app_paths::pin_roots(Some(&path)).unwrap();
    settings_store::init(path.join("settings"));
    path
});

#[must_use]
struct IsolatedSettings {
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

async fn isolated_settings() -> IsolatedSettings {
    let lock = SETTINGS_TEST_LOCK.lock().await;
    std::fs::create_dir(&*SUITE_ROOT).unwrap();
    let guard = IsolatedSettings { _guard: lock };
    std::fs::create_dir(settings_store::global_dir()).unwrap();
    let claude = SUITE_ROOT.join("claude-fixture");
    std::fs::write(&claude, FAKE_CLAUDE).unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
    claude_agent_sdk_rs::set_binary_override(Some(claude));
    codex_app_server_sdk_rs::set_binary_override(Some(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_conversation.py"),
    ));
    opencode_sdk_rs::set_binary_override(Some(SUITE_ROOT.join("no-opencode")));
    guard
}

impl Drop for IsolatedSettings {
    fn drop(&mut self) {
        claude_agent_sdk_rs::set_binary_override(None);
        codex_app_server_sdk_rs::set_binary_override(None);
        opencode_sdk_rs::set_binary_override(None);
        if let Err(error) = std::fs::remove_dir_all(&*SUITE_ROOT) {
            eprintln!("could not remove disposable settings: {error}");
        }
    }
}

// The spawn tests need the real catalog protocol, without reading user CLI
// configuration or relying on the installed CLI's current model list.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
    printf '%s\n' '2.1.0 (Claude Code)'
    exit 0
fi
read -r initialize
id=$(printf '%s' "$initialize" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"models":[{"value":"opus","displayName":"Opus","description":"Opus","supportsEffort":true,"supportedEffortLevels":["low","medium","high"]}],"commands":[],"account":{}}}}\n' "$id"
while read -r ignored; do :; done
"#;


#[tokio::test]
async fn competing_language_invitations_preserve_the_first_confirmed_choice() {
    use cadencr_service::domain::settings_store::{
        global_read, global_set_if_current, global_write_content,
    };

    let _guard = isolated_settings().await;
    global_write_content(r#"{"ui_language":"legacy-english"}"#)
        .await
        .unwrap();
    let answer = |language: &str| {
        global_set_if_current(
            "ui_language".into(),
            "legacy-english".into(),
            language.into(),
        )
    };
    let (accept, decline) = tokio::join!(answer("fr-FR"), answer("en-US"));
    let confirmed = global_read("ui_language").unwrap();
    assert!(matches!(confirmed.as_deref(), Some("fr-FR" | "en-US")));
    assert_eq!(accept.unwrap(), confirmed);
    assert_eq!(decline.unwrap(), confirmed);
    global_write_content(r#"{"ui_language_initialized":true}"#)
        .await
        .unwrap();
    assert_eq!(answer("fr-FR").await.unwrap(), None);
    assert_eq!(global_read("ui_language").unwrap(), None);
}
