//! A Codex `config/read` refused with a reason that quotes a profile secret,
//! from the app-server subprocess (`tests/fixtures/fake_codex_config_error.py`)
//! through the SDK transport and the Codex adapter to what the user reads:
//! the error that fails a session start and the provider catalog's status.
//! Own test binary: the Codex binary override and `settings_store::init` are
//! process-wide.

use std::collections::HashMap;
use std::path::Path;

use cadencr_service::domain::agents::adapter::RuntimeSpawnConfig;
use cadencr_service::domain::agents::codex::profiles::{self, ProfileDraft};
use cadencr_service::domain::agents::providers::provider_registry;
use cadencr_service::domain::agents::runtime::ProviderStatus;
use serde_json::json;

const SECRET: &str = "sk-cadencr-config-read-secret";

fn assert_masked(message: &str) {
    assert!(
        message.contains("Codex could not read the effective configuration"),
        "{message}"
    );
    assert!(
        message.contains("`model_provider`"),
        "the reason is kept: {message}"
    );
    assert!(
        message.contains("•••"),
        "the secret is masked in place: {message}"
    );
    assert!(!message.contains(SECRET), "the secret leaked: {message}");
}

#[tokio::test]
async fn a_refused_config_read_reaches_the_user_with_the_profile_secret_masked() {
    let settings = tempfile::tempdir().unwrap();
    cadencr_service::domain::settings_store::init(settings.path().to_path_buf());
    codex_app_server_sdk_rs::set_binary_override(Some(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_config_error.py")
            .canonicalize()
            .unwrap(),
    ));
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();
    let env = HashMap::from([("OPENAI_API_KEY".to_string(), SECRET.to_string())]);
    let codex = provider_registry()
        .adapter("codex_cli")
        .expect("Codex adapter");

    // Starting a session with the profile's environment.
    let spawn = codex
        .spawn(
            json!("hello"),
            RuntimeSpawnConfig {
                cwd: cwd.clone(),
                env: Some(env.clone()),
                ..RuntimeSpawnConfig::default()
            },
        )
        .await;
    let Err(error) = spawn else {
        panic!("a refused config/read fails the session start");
    };
    assert_masked(&error.to_string());

    // Probing the catalog of a saved profile carrying that secret.
    let home = tempfile::tempdir().unwrap();
    let config = home.path().canonicalize().unwrap().join("config.toml");
    std::fs::write(&config, "").unwrap();
    let profile = profiles::create(ProfileDraft {
        name: "Secret profile".to_string(),
        config_path: Some(config.display().to_string()),
        env,
        env_unset: Vec::new(),
    })
    .await
    .expect("profile saved");
    let pool = sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap();
    let catalog = codex
        .catalog_entry_live_for_settings(&pool, Some(&cwd), Some(&profile.id))
        .await;
    assert_eq!(catalog.status, ProviderStatus::Unavailable);
    assert_masked(catalog.status_message.as_deref().unwrap_or_default());
}
