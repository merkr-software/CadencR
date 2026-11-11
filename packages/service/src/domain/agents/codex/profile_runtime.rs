use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};

use codex_app_server_sdk_rs::{AppServerSpawnOptions, CodexAppServerClient, CodexModel};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::app_server_failure;
use super::revision_cache;
use super::timeouts::{
    with_probe_timeout, with_timeout, FINGERPRINT_MODELS_TIMEOUT, PROBE_TIMEOUT,
};

pub(super) use super::native_config::{
    catalog_with_effective_config, enrich_resume_config, native_effective_config,
};

use super::{profiles, unavailable_catalog, DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE, PROVIDER_ID};
use crate::domain::agents::adapter::{ResolvedRuntimeProfile, RuntimeError};
use crate::domain::agents::adapter::{RuntimeConfigOverrides, RuntimeEffectiveConfig};
use crate::domain::agents::runtime::ProviderCatalogEntry;
use crate::domain::agents::runtime::{ProviderProfileEntry, ProviderProfilesResponse};
use crate::shared::keyed_locks::KeyedLocks;

pub(super) async fn probe_models_and_config(
    profile: Option<&ResolvedRuntimeProfile>,
    cwd: &Path,
) -> Result<(Vec<CodexModel>, Value), RuntimeError> {
    let (config, models) = probe_config_and_models(profile, cwd, PROBE_TIMEOUT).await?;
    Ok((models?, config))
}

/// One throwaway app-server's `config/read`, then its `model/list`, whose
/// failure is returned apart: the fingerprint stands on the config alone.
async fn probe_config_and_models(
    profile: Option<&ResolvedRuntimeProfile>,
    cwd: &Path,
    models_timeout: Duration,
) -> Result<(Value, Result<Vec<CodexModel>, RuntimeError>), RuntimeError> {
    let client = CodexAppServerClient::spawn_with_options(app_server_spawn_options(
        profile.map(|profile| profile.env.clone()),
        profile
            .map(|profile| profile.env_unset.clone())
            .unwrap_or_default(),
        Some(cwd.to_path_buf()),
    ))
    .await?;
    let result = async {
        client.initialize_with_timeout(PROBE_TIMEOUT).await?;
        let config = with_probe_timeout("Codex config/read", client.config_read(cwd))
            .await
            .map_err(|_| RuntimeError::new("Codex rejected the effective configuration"))?;
        let models = with_timeout(models_timeout, "Codex model/list", client.model_list()).await;
        Ok::<_, RuntimeError>((config, models))
    }
    .await;
    client.shutdown().await;
    let secrets = app_server_failure::secrets(profile.map(|profile| &profile.env));
    let explain = |error| app_server_failure::explain(&client, error, &secrets);
    let (config, models) = result.map_err(explain)?;
    Ok((config, models.map_err(explain)))
}

pub(super) async fn resolved_effective_config(
    selection: Option<&str>,
    cwd: &Path,
    overrides: &RuntimeConfigOverrides,
) -> Result<RuntimeEffectiveConfig, RuntimeError> {
    let profile = resolve_profile_for_selection(selection)?;
    // The result is written into the session's runtime config, so a config
    // the user just edited must win: a probe is reused only while no config
    // file changed, and its models only briefly. While the app-server is down,
    // the configuration behind the catalog the picker still shows stands in.
    let probe = match fingerprint(&profile, cwd).await {
        Ok(cached) if cached.age < MODELS_REUSE && cached.probe.models.is_ok() => Ok(cached.probe),
        Ok(_) => probe_fingerprint(&profile, cwd, PROBE_TIMEOUT)
            .await
            .map(|fresh| fresh.probe),
        Err(error) => Err(error),
    };
    let models = probe.and_then(|probe| match &probe.models {
        Ok(models) => Ok((models.clone(), probe)),
        Err(error) => Err(RuntimeError::new(error.clone())),
    });
    match models {
        Ok((models, probe)) => Ok(effective_config_from(&models, &probe.config, overrides)),
        Err(error) => {
            let Some(probe) = super::live_catalog::last_known_probe(&profile, cwd).await else {
                return Err(error);
            };
            tracing::warn!(
                %error,
                "Codex configuration probe failed; resolving from the last known catalog",
            );
            Ok(effective_config_from(
                &probe.models,
                &probe.config,
                overrides,
            ))
        }
    }
}

/// The effective configuration Codex reported (`config_read`), completed from
/// its models, under the user's `overrides`.
fn effective_config_from(
    models: &[CodexModel],
    config_read: &Value,
    overrides: &RuntimeConfigOverrides,
) -> RuntimeEffectiveConfig {
    let mut config = config_read.clone();
    enrich_resume_config(&mut config, models, overrides.model.as_deref());
    let native = native_effective_config(&config);
    RuntimeEffectiveConfig {
        model: overrides.model.clone().or(native.model),
        thinking_effort: overrides.thinking_effort.clone().or(native.thinking_effort),
        fast_mode: overrides
            .fast_mode
            .unwrap_or(native.fast_mode.unwrap_or(false)),
    }
}

/// How long the models a fingerprint probe listed stand in for a fresh
/// `model/list` when resolving the effective configuration. They follow the
/// account and the CLI, which no file stamp tracks, so only a session-opening
/// burst (profile, then effective configuration) shares them.
const MODELS_REUSE: Duration = Duration::from_secs(30);

/// One fingerprint probe per profile and directory at a time: a session
/// resolves its profile and its effective configuration concurrently.
static FINGERPRINT_FLIGHTS: LazyLock<KeyedLocks<revision_cache::RevisionKey>> =
    LazyLock::new(KeyedLocks::default);

/// The fingerprint of `profile`'s effective configuration in `cwd`, and the
/// probe behind it, reused while no config layer file changes.
async fn fingerprint(
    profile: &ResolvedRuntimeProfile,
    cwd: &Path,
) -> Result<revision_cache::Fingerprint, RuntimeError> {
    let key = revision_key(profile, cwd);
    if let Some(cached) = revision_cache::cached(&key) {
        return Ok(cached);
    }
    let flight = FINGERPRINT_FLIGHTS.lock_for(&key).await;
    let _flight = flight.lock().await;
    // A probe that ran while we waited answered for us.
    match revision_cache::cached(&key) {
        Some(cached) => Ok(cached),
        None => probe_fingerprint(profile, cwd, FINGERPRINT_MODELS_TIMEOUT).await,
    }
}

/// One throwaway app-server answers both the runtime fingerprint
/// (`config/read`) and the effective configuration (`model/list` too, given
/// `models_timeout`).
async fn probe_fingerprint(
    profile: &ResolvedRuntimeProfile,
    cwd: &Path,
    models_timeout: Duration,
) -> Result<revision_cache::Fingerprint, RuntimeError> {
    let probe_started = SystemTime::now();
    let (mut config, models) = probe_config_and_models(Some(profile), cwd, models_timeout).await?;
    let revision = fingerprint_effective_config(&profile.revision, &mut config)?;
    let probe = Arc::new(revision_cache::ProfileProbe {
        config,
        // Kept with the probe: the effective configuration surfaces it.
        models: models.map_err(|error| error.to_string()),
    });
    let key = revision_key(profile, cwd);
    revision_cache::store(key, revision.clone(), Arc::clone(&probe), probe_started);
    Ok(revision_cache::Fingerprint {
        revision,
        probe,
        age: Duration::ZERO,
    })
}

fn revision_key(profile: &ResolvedRuntimeProfile, cwd: &Path) -> revision_cache::RevisionKey {
    revision_cache::RevisionKey::new(&profile.env, &profile.env_unset, cwd, &profile.revision)
}

fn fingerprint_effective_config(
    stored_revision: &str,
    config: &mut Value,
) -> Result<String, RuntimeError> {
    let mut digest = Sha256::new();
    digest.update(stored_revision.as_bytes());
    // Codex serializes config maps from a HashMap, so key order differs on
    // every app-server; hash key-sorted or every prompt looks like a config
    // change and forces a respawn.
    config.sort_all_objects();
    digest.update(serde_json::to_vec(config).map_err(|_| {
        RuntimeError::new("Codex effective configuration could not be fingerprinted")
    })?);
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(super) fn app_server_spawn_options(
    env: Option<HashMap<String, String>>,
    env_unset: Vec<String>,
    cwd: Option<PathBuf>,
) -> AppServerSpawnOptions {
    AppServerSpawnOptions::builder()
        .maybe_env(env)
        .env_unset(env_unset)
        .maybe_cwd(cwd)
        .enable_features(vec![DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE.to_string()])
        .build()
}

pub(super) fn profile_catalog() -> ProviderProfilesResponse {
    let active = profiles::active_id().unwrap_or_else(|| "default".to_string());
    let mut entries = vec![ProviderProfileEntry {
        id: "default".to_string(),
        label: "Default Codex home".to_string(),
        description: Some("Uses the user's shared Codex home and config".to_string()),
        is_default: true,
    }];
    entries.extend(
        profiles::list()
            .into_iter()
            .map(|profile| ProviderProfileEntry {
                id: profile.id,
                label: profile.name,
                description: None,
                is_default: false,
            }),
    );
    ProviderProfilesResponse {
        provider: PROVIDER_ID.to_string(),
        active_profile: active,
        default_profile: "default".to_string(),
        profiles: entries,
    }
}

pub(super) async fn resolve_profile(
    selection: Option<&str>,
    cwd: &Path,
) -> Result<ResolvedRuntimeProfile, RuntimeError> {
    let mut profile = resolve_profile_for_selection(selection)?;
    profile.revision = fingerprint(&profile, cwd).await?.revision;
    Ok(profile)
}

/// Selection/catalog preparation is local. Runtime resolution replaces this
/// storage revision with a fresh fingerprint of Codex's effective config.
pub(super) fn resolve_profile_for_selection(
    selection: Option<&str>,
) -> Result<ResolvedRuntimeProfile, RuntimeError> {
    let resolved = if selection == Some("default") {
        None
    } else {
        profiles::resolve(selection).map_err(|error| RuntimeError::new(error.to_string()))?
    };
    let Some(resolved) = resolved else {
        return Ok(ResolvedRuntimeProfile {
            identity: "default".to_string(),
            revision: "default".to_string(),
            env: HashMap::new(),
            env_unset: Vec::new(),
            state_identity: Some(
                profiles::default_home()
                    .map(|home| home.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "unresolved-codex-home".to_string()),
            ),
        });
    };
    let mut env = resolved.profile.env;
    if resolved.profile.config_path.is_some() {
        let home = resolved
            .effective_home
            .as_deref()
            .expect("configured profile home");
        env.insert(
            "CODEX_HOME".to_string(),
            home.to_string_lossy().into_owned(),
        );
    }
    Ok(ResolvedRuntimeProfile {
        identity: resolved.profile.id,
        revision: resolved.revision,
        env,
        env_unset: resolved.profile.env_unset,
        state_identity: Some(
            resolved
                .effective_home
                .map(|home| home.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unresolved-codex-home".to_string()),
        ),
    })
}

/// The catalog of `profile` (none: the active one) in `cwd` (none: no workspace).
pub(super) async fn catalog_for_profile(
    profile: Option<&str>,
    cwd: Option<&Path>,
) -> ProviderCatalogEntry {
    let resolved = match resolve_profile_for_selection(profile) {
        Ok(profile) => profile,
        Err(error) => return unavailable_catalog(error.to_string()),
    };
    super::live_catalog::profile_catalog(&resolved, cwd).await
}

#[cfg(test)]
mod tests {
    use super::{
        effective_config_from, fingerprint_effective_config, resolve_profile_for_selection,
    };
    use crate::domain::agents::adapter::RuntimeConfigOverrides;
    use codex_app_server_sdk_rs::CodexModel;
    use serde_json::json;

    #[test]
    fn native_default_selection_does_not_need_a_running_cli() {
        let profile = resolve_profile_for_selection(Some("default")).unwrap();
        assert_eq!(profile.identity, "default");
        assert_eq!(profile.revision, "default");
        assert!(profile.env.is_empty());
        assert!(profile.env_unset.is_empty());
        assert!(profile.state_identity.is_some());
    }

    #[test]
    fn effective_revision_ignores_object_key_order() {
        let mut ordered: serde_json::Value =
            serde_json::from_str(r#"{"config":{"a":1,"b":{"x":1,"y":2}}}"#).unwrap();
        let mut shuffled: serde_json::Value =
            serde_json::from_str(r#"{"config":{"b":{"y":2,"x":1},"a":1}}"#).unwrap();
        assert_eq!(
            fingerprint_effective_config("stored", &mut ordered).unwrap(),
            fingerprint_effective_config("stored", &mut shuffled).unwrap()
        );
    }

    #[test]
    fn effective_revision_tracks_config_layers_and_profile_changes() {
        let mut config = json!({"config": {"model": "native", "model_reasoning_effort": "low"}});
        let before = fingerprint_effective_config("stored", &mut config).unwrap();
        assert_eq!(
            before,
            fingerprint_effective_config("stored", &mut config).unwrap()
        );
        assert_ne!(
            before,
            fingerprint_effective_config("changed-env", &mut config).unwrap()
        );
        let mut layered = json!({"config": {"model": "project", "model_reasoning_effort": "high"}});
        assert_ne!(
            before,
            fingerprint_effective_config("stored", &mut layered).unwrap()
        );
    }

    #[test]
    fn the_effective_config_completes_the_reported_one_from_the_models() {
        let models = vec![CodexModel {
            id: "gpt-default".to_string(),
            label: "GPT".to_string(),
            description: None,
            supported_efforts: vec!["low".to_string(), "high".to_string()],
            default_effort: Some("high".to_string()),
            service_tiers: vec![],
            context_window: None,
            is_default: true,
        }];
        let config = json!({"config": {"service_tier": "priority"}});

        let native = effective_config_from(&models, &config, &RuntimeConfigOverrides::default());
        assert_eq!(native.model.as_deref(), Some("gpt-default"));
        assert_eq!(native.thinking_effort.as_deref(), Some("high"));
        assert!(native.fast_mode);
        assert_eq!(
            config,
            json!({"config": {"service_tier": "priority"}}),
            "the cached config stays as read"
        );

        let overridden = effective_config_from(
            &models,
            &config,
            &RuntimeConfigOverrides {
                model: Some("gpt-picked".to_string()),
                thinking_effort: Some("low".to_string()),
                fast_mode: Some(false),
            },
        );
        assert_eq!(overridden.model.as_deref(), Some("gpt-picked"));
        assert_eq!(overridden.thinking_effort.as_deref(), Some("low"));
        assert!(!overridden.fast_mode);
    }
}
