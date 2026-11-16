use std::path::Path;

use crate::domain::agents::adapter::{ResolvedRuntimeProfile, RuntimeError};
use crate::domain::agents::runtime::{ProviderProfileEntry, ProviderProfilesResponse};

pub(super) fn catalog() -> ProviderProfilesResponse {
    let default_profile = super::profiles::DEFAULT_PROFILE_NAME.to_string();
    let active_profile = super::profiles::get_active_profile_name();
    let mut profiles = vec![ProviderProfileEntry {
        id: default_profile.clone(),
        label: "Default".to_string(),
        description: None,
        is_default: true,
    }];
    profiles.extend(super::profiles::list_profiles().into_iter().map(|profile| {
        ProviderProfileEntry {
            label: profile.name.clone(),
            id: profile.name,
            description: None,
            is_default: false,
        }
    }));
    ProviderProfilesResponse {
        provider: super::PROVIDER_ID.to_string(),
        active_profile,
        default_profile,
        profiles,
    }
}

pub(super) fn resolve(
    selection: Option<&str>,
    _cwd: &Path,
) -> Result<ResolvedRuntimeProfile, RuntimeError> {
    let (identity, env) = super::profiles::resolve_profile_env_by_name(selection)
        .map_err(|error| RuntimeError::new(error.to_string()))?;
    let env = env.unwrap_or_default();
    let mut revision_parts = env.iter().collect::<Vec<_>>();
    revision_parts.sort_unstable_by_key(|(left, _)| *left);
    let revision_source = revision_parts
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\0");
    use sha2::Digest;
    let revision = sha2::Sha256::digest(revision_source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(ResolvedRuntimeProfile {
        identity,
        revision,
        env,
        env_unset: Vec::new(),
        state_identity: None,
    })
}
