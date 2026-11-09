use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::domain::settings_store;
use crate::error::AppError;

pub const PROFILES_KEY: &str = "codex_profiles";
pub const ACTIVE_PROFILE_KEY: &str = "codex_active_profile";

mod types;
pub use types::*;

pub fn list() -> Vec<CodexProfile> {
    settings_store::global_get_object(PROFILES_KEY)
        .values()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect()
}

pub fn get(id: &str) -> Option<CodexProfile> {
    settings_store::global_get_object(PROFILES_KEY)
        .get(id)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

pub fn active_id() -> Option<String> {
    settings_store::global_get_nonempty(ACTIVE_PROFILE_KEY)
}

pub fn views() -> Result<Vec<CodexProfileView>, AppError> {
    let active = active_id();
    list()
        .into_iter()
        .map(|profile| view(profile, active.as_deref()))
        .collect()
}

pub async fn create(draft: ProfileDraft) -> Result<CodexProfileView, AppError> {
    let profile = profile_from_draft(Uuid::new_v4().to_string(), draft)?;
    validate_profile(&profile)?;
    read_config_and_revision(&profile)?;
    let id = profile.id.clone();
    let stored = serde_json::to_value(&profile)
        .map_err(|error| AppError::internal(format!("could not encode Codex profile: {error}")))?;
    settings_store::global_modify_object(PROFILES_KEY, move |profiles| {
        profiles.insert(id, stored);
        Ok(())
    })
    .await?;
    view(profile, active_id().as_deref())
}

pub async fn update(
    id: &str,
    update: ProfileUpdate,
    allow_home_change: bool,
) -> Result<CodexProfileView, AppError> {
    let existing = get(id).ok_or_else(|| AppError::NotFound(format!("Codex profile '{id}'")))?;
    let profile = apply_update(existing, update, allow_home_change)?;
    validate_profile(&profile)?;
    read_config_and_revision(&profile)?;
    let id_owned = id.to_string();
    let stored = serde_json::to_value(&profile)
        .map_err(|error| AppError::internal(format!("could not encode Codex profile: {error}")))?;
    settings_store::global_modify_object(PROFILES_KEY, move |profiles| {
        profiles.insert(id_owned, stored);
        Ok(())
    })
    .await?;
    view(profile, active_id().as_deref())
}

pub async fn delete(id: &str) -> Result<(), AppError> {
    let id_owned = id.to_string();
    settings_store::global_modify_object(PROFILES_KEY, move |profiles| {
        profiles
            .remove(&id_owned)
            .ok_or_else(|| AppError::NotFound(format!("Codex profile '{id_owned}'")))?;
        Ok(())
    })
    .await?;
    if active_id().as_deref() == Some(id) {
        settings_store::global_set(ACTIVE_PROFILE_KEY, "").await?;
    }
    Ok(())
}

pub async fn set_active(id: Option<&str>) -> Result<(), AppError> {
    let id = id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(id) = id {
        resolve(Some(id))?;
    }
    settings_store::global_set(ACTIVE_PROFILE_KEY, id.unwrap_or_default()).await
}

pub fn resolve(selection: Option<&str>) -> Result<Option<ResolvedCodexProfile>, AppError> {
    let id = selection
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .or_else(active_id);
    let Some(id) = id else { return Ok(None) };
    let profile =
        get(&id).ok_or_else(|| AppError::NotFound(format!("Codex profile '{id}' not found")))?;
    validate_profile(&profile)?;
    let effective_home = effective_home(&profile);
    let (config, revision) = read_config_and_revision(&profile)?;
    Ok(Some(ResolvedCodexProfile {
        profile,
        effective_home,
        revision,
        config,
    }))
}

pub fn validate_draft(draft: ProfileDraft) -> ValidationResult {
    let profile = profile_from_draft("validation".to_string(), draft);
    match profile.and_then(|profile| {
        validate_profile(&profile)?;
        let home = effective_home(&profile);
        let (_, revision) = read_config_and_revision(&profile)?;
        Ok((home, revision, profile.config_path.is_some()))
    }) {
        Ok((home, revision, config_exists)) => ValidationResult {
            valid: true,
            validation_scope: "local_syntax".to_string(),
            codex_compatible: None,
            errors: Vec::new(),
            effective_home: home.map(|path| path.to_string_lossy().into_owned()),
            config_exists,
            revision: Some(revision),
        },
        Err(error) => ValidationResult {
            valid: false,
            validation_scope: "local_syntax".to_string(),
            codex_compatible: None,
            errors: vec![ValidationIssue {
                field: "profile".to_string(),
                code: "INVALID_CODEX_PROFILE".to_string(),
                message: error.to_string(),
            }],
            effective_home: None,
            config_exists: false,
            revision: None,
        },
    }
}

fn profile_from_draft(id: String, draft: ProfileDraft) -> Result<CodexProfile, AppError> {
    Ok(CodexProfile {
        id,
        name: draft.name.trim().to_string(),
        config_path: draft.config_path.map(PathBuf::from),
        env: draft.env,
        env_unset: normalize_unset(draft.env_unset),
    })
}

fn apply_update(
    mut profile: CodexProfile,
    update: ProfileUpdate,
    allow_home_change: bool,
) -> Result<CodexProfile, AppError> {
    if let Some(name) = update.name {
        profile.name = name.trim().to_string();
    }
    if !matches!(update.config_path, NullableString::Missing) {
        let next = match update.config_path {
            NullableString::Value(path) => Some(PathBuf::from(path)),
            NullableString::Null => None,
            NullableString::Missing => unreachable!(),
        };
        if next != profile.config_path && !allow_home_change {
            return Err(AppError::Conflict(
                "a Codex profile's config home is immutable; create a new profile".to_string(),
            ));
        }
        profile.config_path = next;
    }
    if let Some(mut env) = update.env {
        for key in update.preserve_env_keys {
            let value = profile.env.get(&key).ok_or_else(|| {
                AppError::BadRequest(format!("cannot preserve unknown env key '{key}'"))
            })?;
            env.entry(key).or_insert_with(|| value.clone());
        }
        profile.env = env;
    } else if !update.preserve_env_keys.is_empty() {
        return Err(AppError::BadRequest(
            "preserve_env_keys requires an env replacement".to_string(),
        ));
    }
    if let Some(env_unset) = update.env_unset {
        profile.env_unset = normalize_unset(env_unset);
    }
    Ok(profile)
}

fn validate_profile(profile: &CodexProfile) -> Result<(), AppError> {
    if profile.name.is_empty() {
        return Err(AppError::BadRequest(
            "profile name must not be empty".to_string(),
        ));
    }
    if let Some(path) = profile.config_path.as_deref() {
        if !path.is_absolute()
            || path.file_name().and_then(|name| name.to_str()) != Some("config.toml")
        {
            return Err(AppError::BadRequest(
                "config_path must be absolute and end with literal config.toml".to_string(),
            ));
        }
        if !path.is_file() {
            return Err(AppError::BadRequest(format!(
                "config file '{}' does not exist",
                path.display()
            )));
        }
    }
    validate_env(&profile.env, &profile.env_unset)
}

fn validate_env(env: &HashMap<String, String>, unset: &[String]) -> Result<(), AppError> {
    let denied = [
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
        "GIT_SSH_COMMAND",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "PATH",
        "HOME",
        "SHELL",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "SSL_CERT_FILE",
        "HOSTALIASES",
        "CODEX_HOME",
    ];
    let unset = unset.iter().collect::<HashSet<_>>();
    for key in env.keys().chain(unset.iter().copied()) {
        if key.is_empty() || key.contains('=') || key.bytes().any(|byte| byte == 0) {
            return Err(AppError::BadRequest(format!("invalid env key '{key}'")));
        }
        if denied.iter().any(|denied| key.eq_ignore_ascii_case(denied)) {
            return Err(AppError::BadRequest(format!(
                "env key '{key}' is not allowed"
            )));
        }
    }
    if env.keys().any(|key| unset.contains(key)) {
        return Err(AppError::BadRequest(
            "an env key cannot be both set and unset".to_string(),
        ));
    }
    if env.values().any(|value| value.contains('\0')) {
        return Err(AppError::BadRequest(
            "env values must not contain NUL bytes".to_string(),
        ));
    }
    Ok(())
}

fn normalize_unset(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn read_config_and_revision(profile: &CodexProfile) -> Result<(Option<Value>, String), AppError> {
    let mut digest = Sha256::new();
    digest.update(profile.id.as_bytes());
    digest.update([0]);
    digest.update(profile.name.as_bytes());
    if let Some(path) = profile.config_path.as_deref() {
        digest.update(path.as_os_str().as_encoded_bytes());
    }
    let sorted_env = profile
        .env
        .iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    digest.update(
        serde_json::to_vec(&sorted_env).map_err(|error| AppError::internal(error.to_string()))?,
    );
    digest.update(
        serde_json::to_vec(&profile.env_unset)
            .map_err(|error| AppError::internal(error.to_string()))?,
    );
    let config = match profile.config_path.as_deref() {
        Some(path) => {
            let source = std::fs::read_to_string(path).map_err(|error| {
                AppError::BadRequest(format!("could not read '{}': {error}", path.display()))
            })?;
            let parsed = source.parse::<toml::Value>().map_err(|_| {
                AppError::BadRequest(format!("invalid TOML in Codex config '{}'", path.display()))
            })?;
            digest.update(source.as_bytes());
            Some(
                serde_json::to_value(parsed)
                    .map_err(|error| AppError::internal(error.to_string()))?,
            )
        }
        None => None,
    };
    let revision = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((config, revision))
}

fn view(profile: CodexProfile, active: Option<&str>) -> Result<CodexProfileView, AppError> {
    let effective_home = effective_home(&profile);
    // Listing remains available when an external config is temporarily missing
    // or malformed, so the user can repair or delete the stored profile.
    let revision = read_config_and_revision(&profile)
        .map(|(_, revision)| revision)
        .unwrap_or_else(|_| "invalid".to_string());
    let mut env_keys = profile.env.keys().cloned().collect::<Vec<_>>();
    env_keys.sort();
    Ok(CodexProfileView {
        id: profile.id.clone(),
        name: profile.name,
        config_path: profile
            .config_path
            .map(|path| path.to_string_lossy().into_owned()),
        effective_home: effective_home.map(|path| path.to_string_lossy().into_owned()),
        env_keys,
        env_unset: profile.env_unset,
        revision,
        is_active: active == Some(profile.id.as_str()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_or_renamed_config() {
        for path in ["config.toml", "/tmp/codex.toml"] {
            let result = validate_profile(&CodexProfile {
                id: "id".into(),
                name: "name".into(),
                config_path: Some(path.into()),
                env: HashMap::new(),
                env_unset: Vec::new(),
            });
            assert!(matches!(result, Err(AppError::BadRequest(_))));
        }
    }

    #[test]
    fn explicit_secret_preservation_does_not_treat_stars_as_magic() {
        let existing = CodexProfile {
            id: "id".into(),
            name: "name".into(),
            config_path: None,
            env: HashMap::from([("TOKEN".into(), "secret".into())]),
            env_unset: Vec::new(),
        };
        let updated = apply_update(
            existing,
            ProfileUpdate {
                name: None,
                config_path: NullableString::Missing,
                env: Some(HashMap::from([("LABEL".into(), "***".into())])),
                env_unset: None,
                preserve_env_keys: vec!["TOKEN".into()],
            },
            true,
        )
        .unwrap();
        assert_eq!(updated.env["TOKEN"], "secret");
        assert_eq!(updated.env["LABEL"], "***");
    }

    #[test]
    fn update_distinguishes_missing_config_path_from_explicit_null() {
        let missing: ProfileUpdate = serde_json::from_value(serde_json::json!({})).unwrap();
        let null: ProfileUpdate =
            serde_json::from_value(serde_json::json!({ "config_path": null })).unwrap();
        assert!(matches!(missing.config_path, NullableString::Missing));
        assert!(matches!(null.config_path, NullableString::Null));
    }

    #[test]
    fn list_view_survives_missing_external_config() {
        let profile = CodexProfile {
            id: "broken".into(),
            name: "Repair me".into(),
            config_path: Some(PathBuf::from("/definitely/missing/config.toml")),
            env: HashMap::new(),
            env_unset: Vec::new(),
        };
        let view = view(profile, None).unwrap();
        assert_eq!(view.revision, "invalid");
        assert_eq!(view.id, "broken");
    }

    #[test]
    fn explicit_null_home_change_is_rejected_when_profile_is_referenced() {
        let existing = CodexProfile {
            id: "id".into(),
            name: "name".into(),
            config_path: Some(PathBuf::from("/tmp/home/config.toml")),
            env: HashMap::new(),
            env_unset: Vec::new(),
        };
        let result = apply_update(
            existing,
            ProfileUpdate {
                name: None,
                config_path: NullableString::Null,
                env: None,
                env_unset: None,
                preserve_env_keys: Vec::new(),
            },
            false,
        );
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }

    #[test]
    fn env_replacement_removes_unpreserved_secret() {
        let existing = CodexProfile {
            id: "id".into(),
            name: "name".into(),
            config_path: None,
            env: HashMap::from([("TOKEN".into(), "secret".into())]),
            env_unset: Vec::new(),
        };
        let updated = apply_update(
            existing,
            ProfileUpdate {
                name: None,
                config_path: NullableString::Missing,
                env: Some(HashMap::new()),
                env_unset: None,
                preserve_env_keys: Vec::new(),
            },
            true,
        )
        .unwrap();
        assert!(updated.env.is_empty());
    }
}
