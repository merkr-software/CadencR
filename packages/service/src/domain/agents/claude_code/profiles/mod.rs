//! Claude Code env-var profiles, persisted in the user JSON settings.
//!
//! A profile is a named `{ ENV_KEY: VALUE }` map merged on top of the inherited
//! environment when spawning the Claude Code CLI. Profiles live under the nested
//! `profiles` section of the global settings file, so they are programmatically
//! editable at `profiles.<name>.<ENV_KEY>`:
//!
//! ```json
//! { "profiles": { "bedrock": { "AWS_REGION": "us-east-1" } } }
//! ```
//!
//! The reserved name `default` is never stored and always means "inject
//! nothing". The active profile *name* is a scalar setting under
//! `ACTIVE_PROFILE_KEY`; absent, empty, or `"default"` all mean the default.

mod migrate;
mod security;

pub use migrate::migrate_from_sqlite;
pub use security::redact_env_for_response;

use std::collections::HashMap;

use serde_json::Value;

use crate::domain::settings_store;
use crate::error::AppError;

pub const DEFAULT_PROFILE_NAME: &str = "default";
pub const ACTIVE_PROFILE_KEY: &str = "claude_code_active_profile";
/// Top-level settings key holding the nested `<name> -> { env }` profile map.
pub(crate) const PROFILES_KEY: &str = "profiles";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCodeProfile {
    pub name: String,
    pub env: HashMap<String, String>,
}

/// Project a stored profile value (a JSON object) into an env map, keeping only
/// string-valued entries.
fn env_from_value(value: &Value) -> HashMap<String, String> {
    match value {
        Value::Object(obj) => obj
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => HashMap::new(),
    }
}

fn env_to_value(env: &HashMap<String, String>) -> Value {
    Value::Object(
        env.iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
    )
}

fn validate_profile_name(name: &str) -> Result<(), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "profile name must not be empty".to_string(),
        ));
    }
    if trimmed.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
        return Err(AppError::BadRequest(
            "profile name 'default' is reserved".to_string(),
        ));
    }
    Ok(())
}

pub fn list_profiles() -> Vec<ClaudeCodeProfile> {
    // `global_get_object` returns a sorted (BTreeMap) map, so names come out
    // ordered without an explicit sort.
    settings_store::global_get_object(PROFILES_KEY)
        .iter()
        .map(|(name, value)| ClaudeCodeProfile {
            name: name.clone(),
            env: env_from_value(value),
        })
        .collect()
}

pub fn get_profile(name: &str) -> Option<ClaudeCodeProfile> {
    settings_store::global_get_object(PROFILES_KEY)
        .get(name)
        .map(|value| ClaudeCodeProfile {
            name: name.to_string(),
            env: env_from_value(value),
        })
}

pub async fn upsert_profile(
    name: &str,
    env: &HashMap<String, String>,
) -> Result<ClaudeCodeProfile, AppError> {
    validate_profile_name(name)?;
    for key in env.keys() {
        if security::is_denied_env_key(key) {
            return Err(AppError::BadRequest(format!(
                "env key '{key}' is not allowed in profiles"
            )));
        }
    }
    let name_owned = name.to_string();
    let value = env_to_value(env);
    settings_store::global_modify_object(PROFILES_KEY, move |obj| {
        obj.insert(name_owned, value);
        Ok(())
    })
    .await?;
    Ok(ClaudeCodeProfile {
        name: name.to_string(),
        env: env.clone(),
    })
}

pub async fn delete_profile(name: &str) -> Result<(), AppError> {
    validate_profile_name(name)?;
    let name_owned = name.to_string();
    settings_store::global_modify_object(PROFILES_KEY, move |obj| {
        if obj.remove(&name_owned).is_none() {
            return Err(AppError::NotFound(format!(
                "profile '{name_owned}' not found"
            )));
        }
        Ok(())
    })
    .await?;
    // If the deleted profile was the active one, reset to default.
    if get_active_profile_name() == name {
        set_active_profile(DEFAULT_PROFILE_NAME).await?;
    }
    Ok(())
}

pub fn get_active_profile_name() -> String {
    settings_store::global_get_nonempty(ACTIVE_PROFILE_KEY)
        .unwrap_or_else(|| DEFAULT_PROFILE_NAME.to_string())
}

pub async fn set_active_profile(name: &str) -> Result<(), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
        return settings_store::global_set(ACTIVE_PROFILE_KEY, DEFAULT_PROFILE_NAME).await;
    }
    // Ensure the profile exists before activating it.
    if get_profile(trimmed).is_none() {
        return Err(AppError::NotFound(format!("profile '{trimmed}' not found")));
    }
    settings_store::global_set(ACTIVE_PROFILE_KEY, trimmed).await
}

/// Resolve the active profile's name and env map. Returns `("default", None)`
/// when no non-default profile is active or the active name points to a deleted
/// profile (logged) — the safe fallback is no extra env so a momentary issue
/// can't break agent spawns.
pub fn resolve_active_profile_env() -> (String, Option<HashMap<String, String>>) {
    let name = get_active_profile_name();
    if name.trim().is_empty() || name.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
        return (DEFAULT_PROFILE_NAME.to_string(), None);
    }
    match get_profile(&name) {
        Some(profile) if !profile.env.is_empty() => (name, Some(profile.env)),
        Some(_) => (name, None),
        None => {
            tracing::warn!(profile = %name, "active claude_code profile no longer exists");
            (name, None)
        }
    }
}

pub fn resolve_profile_env_by_name(
    name: Option<&str>,
) -> Result<(String, Option<HashMap<String, String>>), AppError> {
    let Some(profile_name) = name.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(resolve_active_profile_env());
    };
    if profile_name.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
        return Ok((DEFAULT_PROFILE_NAME.to_string(), None));
    }
    let profile = get_profile(profile_name)
        .ok_or_else(|| AppError::NotFound(format!("profile '{profile_name}' not found")))?;
    let env = if profile.env.is_empty() {
        None
    } else {
        Some(profile.env)
    };
    Ok((profile.name, env))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_env() -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://proxy".to_string(),
        );
        env.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        env
    }

    #[tokio::test]
    async fn upsert_and_list_roundtrip() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        let profiles = list_profiles();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "bedrock");
        assert_eq!(profiles[0].env, sample_env());
    }

    #[tokio::test]
    async fn upsert_rejects_default_name() {
        let err = upsert_profile("default", &sample_env()).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn upsert_overwrites_existing_env() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        let mut replacement = HashMap::new();
        replacement.insert("AWS_REGION".to_string(), "us-east-1".to_string());
        upsert_profile("bedrock", &replacement).await.unwrap();
        let profile = get_profile("bedrock").unwrap();
        assert_eq!(profile.env, replacement);
    }

    #[tokio::test]
    async fn upsert_rejects_denied_key() {
        let mut env = HashMap::new();
        env.insert("LD_PRELOAD".into(), "/tmp/evil.so".into());
        let err = upsert_profile("evil", &env).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));

        let mut env = HashMap::new();
        env.insert("path".into(), "/tmp:/usr/bin".into());
        let err = upsert_profile("evil", &env).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn upsert_accepts_anthropic_api_key() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".into(), "sk-ant-live-xxx".into());
        let profile = upsert_profile("real", &env).await.unwrap();
        assert_eq!(
            profile.env.get("ANTHROPIC_API_KEY").unwrap(),
            "sk-ant-live-xxx"
        );
    }

    #[tokio::test]
    async fn active_env_is_none_for_default() {
        let (name, env) = resolve_active_profile_env();
        assert_eq!(name, DEFAULT_PROFILE_NAME);
        assert!(env.is_none());
    }

    #[tokio::test]
    async fn active_env_returns_name_and_env() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        set_active_profile("bedrock").await.unwrap();
        let (name, env) = resolve_active_profile_env();
        assert_eq!(name, "bedrock");
        assert_eq!(env, Some(sample_env()));
    }

    #[tokio::test]
    async fn active_env_for_deleted_profile_logs_and_returns_none() {
        // Point the active name at a profile that doesn't exist.
        settings_store::global_set(ACTIVE_PROFILE_KEY, "ghost")
            .await
            .unwrap();
        let (name, env) = resolve_active_profile_env();
        assert_eq!(name, "ghost");
        assert!(env.is_none());
    }

    #[tokio::test]
    async fn set_active_rejects_unknown_profile() {
        let err = set_active_profile("bedrock").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn deleting_active_profile_resets_to_default() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        set_active_profile("bedrock").await.unwrap();
        delete_profile("bedrock").await.unwrap();
        assert_eq!(get_active_profile_name(), DEFAULT_PROFILE_NAME);
        let (_, env) = resolve_active_profile_env();
        assert!(env.is_none());
    }

    #[tokio::test]
    async fn delete_missing_profile_is_not_found() {
        let err = delete_profile("bedrock").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn set_active_default_clears_override() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        set_active_profile("bedrock").await.unwrap();
        set_active_profile("default").await.unwrap();
        let (_, env) = resolve_active_profile_env();
        assert!(env.is_none());
    }

    #[tokio::test]
    async fn resolve_profile_env_by_name_returns_default_for_default() {
        let (name, env) = resolve_profile_env_by_name(Some("default")).unwrap();
        assert_eq!(name, DEFAULT_PROFILE_NAME);
        assert_eq!(env, None);
    }

    #[tokio::test]
    async fn resolve_profile_env_by_name_returns_named_env() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        let (name, env) = resolve_profile_env_by_name(Some("bedrock")).unwrap();
        assert_eq!(name, "bedrock");
        assert_eq!(env, Some(sample_env()));
    }

    #[tokio::test]
    async fn resolve_profile_env_by_name_rejects_missing_profile() {
        let err = resolve_profile_env_by_name(Some("missing")).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
