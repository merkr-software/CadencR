use crate::app_state::AppState;
use crate::domain::agents::adapter::{access_mode_wire, RuntimeSpawnConfig};
use crate::domain::agents::permission_modes::{effective_permission_mode, permission_mode_wire};
use crate::domain::agents::providers::{
    resolve_requested_model_entry_or_provider_default, runtime_adapter,
};
use crate::domain::settings::target_thinking_effort;
use crate::domain::ws_session::protocol::{ProviderSetOkPayload, ProviderSetPayload};

use super::switch::{ProviderSetError, SwitchSnapshot};

pub(super) struct SwitchSelection {
    pub provider: String,
    pub runtime: RuntimeSpawnConfig,
    pub provider_changed: bool,
    pub permission_mode_wire: String,
}

pub(super) fn reply(provider: &str, runtime: &RuntimeSpawnConfig) -> ProviderSetOkPayload {
    let access_mode = runtime
        .access_mode
        .as_ref()
        .map(access_mode_wire)
        .map(str::to_string);
    ProviderSetOkPayload {
        provider: provider.to_string(),
        model: runtime.model.clone().unwrap_or_default(),
        profile: runtime.profile.clone(),
        runtime_overrides: runtime.overrides.clone(),
        thinking_effort: runtime.thinking_effort.clone(),
        fast_mode: runtime.fast_mode,
        supports_prompt_receipts: runtime_adapter(provider)
            .is_some_and(|adapter| adapter.supports_prompt_receipts()),
        codex_permission_mode: access_mode.clone(),
        access_mode,
    }
}

pub(super) async fn resolve(
    state: &AppState,
    payload: &ProviderSetPayload,
    snapshot: SwitchSnapshot,
) -> Result<SwitchSelection, ProviderSetError> {
    let adapter = runtime_adapter(&payload.provider).ok_or_else(|| {
        ProviderSetError::new("UNSUPPORTED_PROVIDER", "Runtime provider is unavailable")
    })?;
    let provider_changed = snapshot.provider != payload.provider;
    let previous_model = snapshot.model.clone();
    let mut runtime = snapshot.into_runtime();
    if provider_changed {
        let profile = adapter
            .resolve_profile_for_selection(None, &runtime.cwd)
            .await
            .map_err(|error| ProviderSetError::new("PROFILE_ERROR", error.to_string()))?;
        runtime.profile = profile.as_ref().map(|profile| profile.identity.clone());
        runtime.env = profile
            .as_ref()
            .map(|profile| profile.env.clone())
            .filter(|env| !env.is_empty());
        runtime.env_unset = profile
            .as_ref()
            .map(|profile| profile.env_unset.clone())
            .unwrap_or_default();
        runtime.profile_revision = profile.as_ref().map(|profile| profile.revision.clone());
        runtime.profile_state_identity = profile.and_then(|profile| profile.state_identity);
        runtime.overrides = Default::default();
        runtime.thinking_effort = None;
        runtime.fast_mode = false;
        // Spawn in the mode the chip is about to show (`permission_mode_wire`
        // below), exactly as `session.init` resolves it.
        runtime.permission_mode = effective_permission_mode(&payload.provider, None);
        runtime.access_mode = adapter.configured_access_mode(&state.read_pool).await;
        runtime.allow_bypass_permissions = false;
    }
    let requested_model = payload.model.as_deref().or_else(|| {
        (!provider_changed)
            .then_some(runtime.model.as_deref())
            .flatten()
    });
    let entry = resolve_requested_model_entry_or_provider_default(
        &state.read_pool,
        Some(&runtime.cwd),
        &payload.provider,
        requested_model,
        runtime.profile.as_deref(),
    )
    .await;
    runtime.model = entry.as_ref().map(|entry| entry.id.clone());
    if provider_changed || runtime.model != previous_model {
        // A new provider/model resumes its last-used level, else its default,
        // exactly like a spawn without an explicit level.
        let effort = match entry.as_ref() {
            Some(entry) => target_thinking_effort(&state.read_pool, &payload.provider, entry).await,
            None => None,
        };
        runtime.thinking_effort = effort.clone();
        runtime.overrides.thinking_effort = effort;
    }
    if adapter.supports_profile_config_inheritance() {
        record_explicit_model(&mut runtime, payload.model.as_deref());
        // An unavailable CLI must not make a provider impossible to select.
        // A usable catalog, however, requires the effective configuration too.
        if runtime.model.is_some() {
            let effective = adapter
                .resolve_profile_effective_config(
                    runtime.profile.as_deref(),
                    &runtime.cwd,
                    &runtime.overrides,
                )
                .await
                .map_err(|error| {
                    ProviderSetError::new("PROFILE_CONFIG_ERROR", error.to_string())
                })?;
            runtime.model = effective.model;
            runtime.thinking_effort = effective.thinking_effort;
            runtime.fast_mode = effective.fast_mode;
        }
    }
    let mode_wire = runtime
        .permission_mode
        .as_ref()
        .map(permission_mode_wire)
        .unwrap_or_else(|| adapter.default_permission_mode_wire().into_owned());
    Ok(SwitchSelection {
        provider: payload.provider.clone(),
        runtime,
        provider_changed,
        permission_mode_wire: mode_wire,
    })
}

fn record_explicit_model(runtime: &mut RuntimeSpawnConfig, requested_model: Option<&str>) {
    if requested_model.is_some() {
        runtime.overrides.model = runtime.model.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::record_explicit_model;
    use crate::domain::agents::adapter::{RuntimeConfigOverrides, RuntimeSpawnConfig};

    #[test]
    fn explicit_model_is_launch_override_without_resetting_other_overrides() {
        let mut runtime = RuntimeSpawnConfig {
            model: Some("selected-codex-model".into()),
            overrides: RuntimeConfigOverrides {
                model: Some("old-model".into()),
                thinking_effort: Some("high".into()),
                fast_mode: Some(false),
            },
            ..Default::default()
        };
        record_explicit_model(&mut runtime, Some("selected-codex-model"));
        assert_eq!(
            runtime.overrides.model.as_deref(),
            Some("selected-codex-model")
        );
        assert_eq!(runtime.overrides.thinking_effort.as_deref(), Some("high"));
        assert_eq!(runtime.overrides.fast_mode, Some(false));
    }

    #[test]
    fn inferred_default_remains_inherited() {
        let mut runtime = RuntimeSpawnConfig {
            model: Some("native-default".into()),
            ..Default::default()
        };
        record_explicit_model(&mut runtime, None);
        assert!(runtime.overrides.model.is_none());
    }
}
