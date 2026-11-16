//! How many throwaway `codex app-server`s a Codex session costs before its
//! runtime starts, against a fixture app-server that counts its launches
//! (`tests/fixtures/fake_codex_probe.py`). Own test binary: the Codex binary
//! override and `settings_store::init` are process-wide.

use std::path::Path;

use cadencr_service::domain::agents::adapter::RuntimeConfigOverrides;
use cadencr_service::domain::agents::providers::provider_registry;

/// Opening a session resolves its profile (the effective-config fingerprint)
/// and then its effective configuration. Both read the same `config/read` of
/// the same profile in the same directory, so one app-server answers both; a
/// second resolution with no config file changed launches none, while a
/// config file the user adds is read again.
#[tokio::test]
async fn a_session_profile_and_its_effective_config_share_one_app_server() {
    let settings = tempfile::tempdir().unwrap();
    cadencr_service::domain::settings_store::init(settings.path().to_path_buf());
    let launches = settings.path().join("launches");
    std::env::set_var("CADENCR_FAKE_CODEX_LAUNCHES", &launches);
    codex_app_server_sdk_rs::set_binary_override(Some(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_probe.py")
            .canonicalize()
            .unwrap(),
    ));
    let cwd = tempfile::tempdir().unwrap();
    let cwd = cwd.path().canonicalize().unwrap();
    let codex = provider_registry()
        .adapter("codex_cli")
        .expect("Codex adapter");
    let launched = || {
        std::fs::read_to_string(&launches)
            .unwrap_or_default()
            .lines()
            .count()
    };

    for _ in 0..2 {
        codex
            .resolve_profile(Some("default"), &cwd)
            .await
            .expect("profile resolves");
        let config = codex
            .resolve_profile_effective_config(
                Some("default"),
                &cwd,
                &RuntimeConfigOverrides::default(),
            )
            .await
            .expect("effective config resolves");
        assert_eq!(config.model.as_deref(), Some("qa-model"));
    }

    assert_eq!(launched(), 1, "throwaway app-servers launched");

    std::fs::create_dir_all(cwd.join(".codex")).unwrap();
    std::fs::write(cwd.join(".codex/config.toml"), "model = \"qa-model\"\n").unwrap();
    codex
        .resolve_profile_effective_config(Some("default"), &cwd, &RuntimeConfigOverrides::default())
        .await
        .expect("effective config resolves");
    assert_eq!(launched(), 2, "an added project config is read again");

    // Opening a session asks for both at once: they still share one probe.
    let other = tempfile::tempdir().unwrap();
    let other = other.path().canonicalize().unwrap();
    let overrides = RuntimeConfigOverrides::default();
    let (profile, config) = tokio::join!(
        codex.resolve_profile(Some("default"), &other),
        codex.resolve_profile_effective_config(Some("default"), &other, &overrides),
    );
    profile.expect("profile resolves");
    config.expect("effective config resolves");
    assert_eq!(launched(), 3, "concurrent resolutions share one probe");

    // The fingerprint stands on `config/read`: a failed `model/list` fails
    // only the effective configuration, which needs the models.
    let failing = tempfile::tempdir().unwrap();
    let failing = failing.path().canonicalize().unwrap();
    std::fs::write(failing.join("fail-model-list"), "").unwrap();
    codex
        .resolve_profile(Some("default"), &failing)
        .await
        .expect("the profile resolves without the model list");
    let error = codex
        .resolve_profile_effective_config(
            Some("default"),
            &failing,
            &RuntimeConfigOverrides::default(),
        )
        .await
        .expect_err("the effective configuration needs the model list");
    assert!(error.to_string().contains("MODEL_LIST_FAILED"), "{error}");
    // The fingerprint's own model list failed, so the effective
    // configuration asked again before surfacing the failure.
    assert_eq!(launched(), 5);
}
