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

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::domain::settings_store::{self, file, Scope};
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

fn stored_profile(name: &str, value: &Value) -> Result<ClaudeCodeProfile, AppError> {
    let env = HashMap::deserialize(value).map_err(|_| {
        settings_store::file::invalid_settings(format!(
            "Claude Code profile '{name}' must contain an object of environment strings"
        ))
    })?;
    Ok(ClaudeCodeProfile {
        name: name.to_string(),
        env,
    })
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

pub fn list_profiles() -> Result<Vec<ClaudeCodeProfile>, AppError> {
    settings_store::global_inspect_document(profiles_in)
}

pub(super) fn list_with_active() -> Result<(Vec<ClaudeCodeProfile>, String), AppError> {
    settings_store::global_inspect_document(|doc| {
        let profiles = profiles_in(doc)?;
        let name = active_name(doc)?;
        if name != DEFAULT_PROFILE_NAME && !profiles.iter().any(|profile| profile.name == name) {
            return Err(missing_active_profile(&name));
        }
        Ok((profiles, name))
    })
}

fn profiles_in(doc: &Map<String, Value>) -> Result<Vec<ClaudeCodeProfile>, AppError> {
    file::object_section(doc, PROFILES_KEY)?
        .into_iter()
        .flatten()
        .map(|(name, value)| stored_profile(name, value))
        .collect()
}

fn named_profile(doc: &Map<String, Value>, name: &str) -> Result<ClaudeCodeProfile, AppError> {
    let value = file::object_section(doc, PROFILES_KEY)?
        .and_then(|profiles| profiles.get(name))
        .ok_or_else(|| AppError::NotFound(format!("profile '{name}' not found")))?;
    stored_profile(name, value)
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
    settings_store::global_update_document(move |doc| {
        let active = active_name(doc)?;
        file::edit_object_section(doc, PROFILES_KEY, |profiles| {
            profiles
                .remove(&name_owned)
                .ok_or_else(|| AppError::NotFound(format!("profile '{name_owned}' not found")))
        })?;
        if active == name_owned {
            doc.insert(
                ACTIVE_PROFILE_KEY.into(),
                Value::String(DEFAULT_PROFILE_NAME.to_string()),
            );
        }
        Ok(())
    })
    .await
}

pub fn get_active_profile_name() -> Result<String, AppError> {
    settings_store::global_inspect_document(checked_active_name)
}

fn active_name(doc: &Map<String, Value>) -> Result<String, AppError> {
    Ok(
        file::read_scalar(doc, Scope::Workspace, ACTIVE_PROFILE_KEY)?
            .filter(|value| {
                !value.trim().is_empty() && !value.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME)
            })
            .unwrap_or_else(|| DEFAULT_PROFILE_NAME.to_string()),
    )
}

fn checked_active_name(doc: &Map<String, Value>) -> Result<String, AppError> {
    let name = active_name(doc)?;
    if name != DEFAULT_PROFILE_NAME {
        named_active_profile(doc, &name)?;
    }
    Ok(name)
}

fn named_active_profile(
    doc: &Map<String, Value>,
    name: &str,
) -> Result<ClaudeCodeProfile, AppError> {
    named_profile(doc, name).map_err(|error| match error {
        AppError::NotFound(_) => missing_active_profile(name),
        other => other,
    })
}

fn missing_active_profile(name: &str) -> AppError {
    file::invalid_settings(format!(
        "Active Claude Code profile '{name}' does not exist. Fix '{ACTIVE_PROFILE_KEY}' in Edit JSON."
    ))
}

pub async fn set_active_profile(name: &str) -> Result<(), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
        return settings_store::global_set(ACTIVE_PROFILE_KEY, DEFAULT_PROFILE_NAME).await;
    }
    let name = trimmed.to_owned();
    settings_store::global_update_document(move |doc| {
        named_profile(doc, &name)?;
        doc.insert(ACTIVE_PROFILE_KEY.into(), Value::String(name));
        Ok(())
    })
    .await
}

pub fn resolve_active_profile_env() -> Result<(String, Option<HashMap<String, String>>), AppError> {
    resolve_profile_env_by_name(None)
}

pub fn resolve_profile_env_by_name(
    name: Option<&str>,
) -> Result<(String, Option<HashMap<String, String>>), AppError> {
    let name = name.map(str::trim).filter(|value| !value.is_empty());
    if name.is_some_and(|name| name.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME)) {
        return Ok((DEFAULT_PROFILE_NAME.to_string(), None));
    }
    let use_active = name.is_none();
    settings_store::global_inspect_document(|doc| {
        let active;
        let name = match name {
            Some(name) => name,
            None => {
                active = active_name(doc)?;
                &active
            }
        };
        if name.eq_ignore_ascii_case(DEFAULT_PROFILE_NAME) {
            return Ok((DEFAULT_PROFILE_NAME.to_string(), None));
        }
        let profile = if use_active {
            named_active_profile(doc, name)?
        } else {
            named_profile(doc, name)?
        };
        let env = (!profile.env.is_empty()).then_some(profile.env);
        Ok((profile.name, env))
    })
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
        let profiles = list_profiles().unwrap();
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
        let profiles = list_profiles().unwrap();
        let profile = &profiles[0];
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
        let (name, env) = resolve_active_profile_env().unwrap();
        assert_eq!(name, DEFAULT_PROFILE_NAME);
        assert!(env.is_none());
    }

    #[tokio::test]
    async fn active_env_returns_name_and_env() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        set_active_profile("bedrock").await.unwrap();
        let (name, env) = resolve_active_profile_env().unwrap();
        assert_eq!(name, "bedrock");
        assert_eq!(env, Some(sample_env()));
    }

    #[tokio::test]
    async fn active_env_for_deleted_profile_fails() {
        // Point the active name at a profile that doesn't exist.
        settings_store::global_set(ACTIVE_PROFILE_KEY, "ghost")
            .await
            .unwrap();
        assert_eq!(
            resolve_active_profile_env().unwrap_err().code(),
            file::SETTINGS_INVALID
        );
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
        assert_eq!(get_active_profile_name().unwrap(), DEFAULT_PROFILE_NAME);
        let (_, env) = resolve_active_profile_env().unwrap();
        assert!(env.is_none());
    }

    #[tokio::test]
    async fn deleting_with_an_invalid_active_setting_keeps_the_profile() {
        upsert_profile("bedrock", &sample_env()).await.unwrap();
        settings_store::global_write_content(
            r#"{"claude_code_active_profile":[],"profiles":{"bedrock":{"AWS_REGION":"test"}}}"#,
        )
        .await
        .unwrap();

        let error = delete_profile("bedrock").await.unwrap_err();
        assert_eq!(error.code(), file::SETTINGS_INVALID);
        assert_eq!(list_profiles().unwrap()[0].name, "bedrock");
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
        let (_, env) = resolve_active_profile_env().unwrap();
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

    #[tokio::test]
    async fn malformed_profile_environment_is_not_used_for_a_spawn() {
        settings_store::global_write_content(
            r#"{"claude_code_active_profile":"bedrock","profiles":{"bedrock":{"AWS_REGION":5}}}"#,
        )
        .await
        .unwrap();
        assert!(matches!(
            resolve_active_profile_env(),
            Err(AppError::Coded {
                code: file::SETTINGS_INVALID,
                ..
            })
        ));
        assert!(matches!(
            resolve_profile_env_by_name(Some("bedrock")),
            Err(AppError::Coded {
                code: file::SETTINGS_INVALID,
                ..
            })
        ));
    }
}
