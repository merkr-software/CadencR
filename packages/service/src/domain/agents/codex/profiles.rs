use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::domain::settings_store::{self, file, Scope};
use crate::error::AppError;

pub const PROFILES_KEY: &str = "codex_profiles";
pub const ACTIVE_PROFILE_KEY: &str = "codex_active_profile";

mod configuration;
mod types;
use configuration::read_config_and_revision;
pub use types::*;

fn stored_profile(id: &str, value: &Value) -> Result<CodexProfile, AppError> {
    let invalid = || file::invalid_settings(format!("Codex profile '{id}' is malformed"));
    let profile = CodexProfile::deserialize(value).map_err(|_| invalid())?;
    if profile.id != id {
        return Err(invalid());
    }
    Ok(profile)
}

pub fn list() -> Result<Vec<CodexProfile>, AppError> {
    settings_store::global_inspect_document(profiles_in)
}

fn profiles_in(doc: &Map<String, Value>) -> Result<Vec<CodexProfile>, AppError> {
    file::object_section(doc, PROFILES_KEY)?
        .into_iter()
        .flatten()
        .map(|(id, value)| stored_profile(id, value))
        .collect()
}

fn profile_in(doc: &Map<String, Value>, id: &str) -> Result<CodexProfile, AppError> {
    let value = file::object_section(doc, PROFILES_KEY)?
        .and_then(|profiles| profiles.get(id))
        .ok_or_else(|| AppError::NotFound(format!("Codex profile '{id}' not found")))?;
    stored_profile(id, value)
}

fn active_id_in(doc: &Map<String, Value>) -> Result<Option<String>, AppError> {
    Ok(
        file::read_scalar(doc, Scope::Workspace, ACTIVE_PROFILE_KEY)?
            .filter(|id| !id.trim().is_empty()),
    )
}

pub fn active_id() -> Result<Option<String>, AppError> {
    settings_store::global_inspect_document(|doc| {
        Ok(active_profile_in(doc)?.map(|profile| profile.id))
    })
}

pub(super) fn list_with_active() -> Result<(Vec<CodexProfile>, Option<String>), AppError> {
    settings_store::global_inspect_document(|doc| {
        let profiles = profiles_in(doc)?;
        let active = active_id_in(doc)?;
        if let Some(id) = active.as_deref() {
            if !profiles.iter().any(|profile| profile.id == id) {
                return Err(missing_active_profile(id));
            }
        }
        Ok((profiles, active))
    })
}

fn active_profile_in(doc: &Map<String, Value>) -> Result<Option<CodexProfile>, AppError> {
    active_id_in(doc)?
        .as_deref()
        .map(|id| {
            profile_in(doc, id).map_err(|error| match error {
                AppError::NotFound(_) => missing_active_profile(id),
                other => other,
            })
        })
        .transpose()
}

fn missing_active_profile(id: &str) -> AppError {
    file::invalid_settings(format!(
        "Active Codex profile '{id}' does not exist. Fix '{ACTIVE_PROFILE_KEY}' in Edit JSON."
    ))
}

pub(super) fn views(profiles: Vec<CodexProfile>, active: Option<&str>) -> Vec<CodexProfileView> {
    profiles
        .into_iter()
        .map(|profile| view(profile, active))
        .collect()
}

pub async fn create(draft: ProfileDraft) -> Result<CodexProfileView, AppError> {
    let profile = profile_from_draft(Uuid::new_v4().to_string(), draft)?;
    validate_profile(&profile)?;
    let (_, revision) = read_config_and_revision(&profile)?;
    let (profile, active) = settings_store::global_update_document(move |doc| {
        let active = active_id_in(doc)?;
        save_profile(doc, &profile)?;
        Ok((profile, active))
    })
    .await?;
    Ok(profile_view(profile, active.as_deref(), revision))
}

pub async fn update(
    id: &str,
    update: ProfileUpdate,
    allow_home_change: bool,
) -> Result<CodexProfileView, AppError> {
    let current = settings_store::global_inspect_document(|doc| profile_in(doc, id))?;
    let profile = apply_update(current.clone(), update, allow_home_change)?;
    validate_profile(&profile)?;
    let (_, revision) = read_config_and_revision(&profile)?;
    let (profile, active) = settings_store::global_update_document(move |doc| {
        let active = active_id_in(doc)?;
        verify_profile_unchanged(doc, &current)?;
        save_profile(doc, &profile)?;
        Ok((profile, active))
    })
    .await?;
    Ok(profile_view(profile, active.as_deref(), revision))
}

fn verify_profile_unchanged(
    doc: &Map<String, Value>,
    profile: &CodexProfile,
) -> Result<(), AppError> {
    if profile_in(doc, &profile.id)? != *profile {
        return Err(AppError::Conflict(
            "The Codex profile changed while it was being validated. Refresh and try again.".into(),
        ));
    }
    Ok(())
}

fn save_profile(doc: &mut Map<String, Value>, profile: &CodexProfile) -> Result<(), AppError> {
    let stored = serde_json::to_value(profile)
        .map_err(|error| AppError::internal(format!("could not encode Codex profile: {error}")))?;
    file::edit_object_section(doc, PROFILES_KEY, |profiles| {
        profiles.insert(profile.id.clone(), stored);
        Ok(())
    })
}

pub async fn delete(id: &str) -> Result<(), AppError> {
    let id = id.to_string();
    settings_store::global_update_document(move |doc| {
        let active = active_id_in(doc)?;
        file::edit_object_section(doc, PROFILES_KEY, |profiles| {
            profiles
                .remove(&id)
                .ok_or_else(|| AppError::NotFound(format!("Codex profile '{id}'")))
        })?;
        if active.as_deref() == Some(id.as_str()) {
            doc.insert(ACTIVE_PROFILE_KEY.into(), Value::String(String::new()));
        }
        Ok(())
    })
    .await
}

/// Return the profile list and active ID from the same document we saved.
pub(super) async fn set_active(
    id: Option<&str>,
) -> Result<(Vec<CodexProfile>, Option<String>), AppError> {
    let id = id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let selected = id
        .as_deref()
        .map(|id| settings_store::global_inspect_document(|doc| profile_in(doc, id)))
        .transpose()?;
    if let Some(profile) = selected.as_ref() {
        validate_profile(profile)?;
        read_config_and_revision(profile)?;
    }
    settings_store::global_update_document(move |doc| {
        let profiles = profiles_in(doc)?;
        if let Some(profile) = selected.as_ref() {
            verify_profile_unchanged(doc, profile)?;
        }
        doc.insert(
            ACTIVE_PROFILE_KEY.into(),
            Value::String(id.clone().unwrap_or_default()),
        );
        Ok((profiles, id))
    })
    .await
}

pub fn resolve(selection: Option<&str>) -> Result<Option<ResolvedCodexProfile>, AppError> {
    let profile = settings_store::global_inspect_document(|doc| {
        match selection.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => profile_in(doc, id).map(Some),
            None => active_profile_in(doc),
        }
    })?;
    let Some(profile) = profile else {
        return Ok(None);
    };
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

fn view(profile: CodexProfile, active: Option<&str>) -> CodexProfileView {
    // Listing remains available when an external config is temporarily missing
    // or malformed, so the user can repair or delete the stored profile.
    let revision = read_config_and_revision(&profile)
        .map(|(_, revision)| revision)
        .unwrap_or_else(|_| "invalid".to_string());
    profile_view(profile, active, revision)
}

fn profile_view(profile: CodexProfile, active: Option<&str>, revision: String) -> CodexProfileView {
    let effective_home = effective_home(&profile);
    let mut env_keys = profile.env.keys().cloned().collect::<Vec<_>>();
    env_keys.sort();
    CodexProfileView {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn active_profile_resolution_requires_readable_settings() {
        let path = settings_store::paths::global_file(&settings_store::global_dir());
        assert!(resolve(None).unwrap().is_none());
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(
            resolve(None),
            Err(AppError::Coded {
                code: settings_store::file::SETTINGS_READ_FAILED,
                ..
            })
        ));
        std::fs::remove_dir(&path).unwrap();
        settings_store::global_write_content(
            r#"{"codex_active_profile":"work","codex_profiles":{"work":5}}"#,
        )
        .await
        .unwrap();
        assert_eq!(resolve(None).unwrap_err().code(), file::SETTINGS_INVALID);
        settings_store::global_write_content(
            r#"{"codex_active_profile":"work","codex_profiles":{"work":{"id":"work","name":"Work"}}}"#,
        ).await.unwrap();
        assert_eq!(resolve(None).unwrap().unwrap().profile.id, "work");
    }

    #[tokio::test]
    async fn concurrent_activation_and_deletion_never_leave_a_dangling_profile() {
        settings_store::global_write_content(
            r#"{"codex_profiles":{"work":{"id":"work","name":"Work"}}}"#,
        )
        .await
        .unwrap();

        let (activation, deletion) = tokio::join!(set_active(Some("work")), delete("work"));
        if let Err(error) = activation {
            assert!(matches!(error, AppError::NotFound(_)), "{error}");
        }
        deletion.unwrap();
        assert!(resolve(None).unwrap().is_none());
        assert!(list().unwrap().is_empty());
    }

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
        let view = view(profile, None);
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
