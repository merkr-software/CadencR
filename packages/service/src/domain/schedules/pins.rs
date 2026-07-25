//! Validation for the runtime options a schedule pins.
//!
//! A schedule is written once and read by the poll loop months later, so a pin
//! the provider can't honor has to fail loudly at that point rather than
//! quietly degrade. "Run the nightly sweep in plan mode" turning into
//! "bypassPermissions, the provider default" is the failure mode this exists to
//! prevent.
//!
//! Both target kinds share these: `runtime::resolve` uses them for the
//! conversation a schedule creates, `dispatch` for one it posts into.

use crate::domain::agents::adapter::{access_mode_wire, parse_access_mode_wire};
use crate::domain::agents::permission_modes::{
    parse_permission_mode, permission_mode_wire, provider_supports_mode,
};
use crate::domain::agents::providers::resolve_model_or_error_for_profile;
use crate::domain::agents::runtime_adapter;
use crate::error::AppError;

/// Canonicalize a pinned collaboration mode against the provider that will run
/// it, rejecting one it can't execute.
///
/// `parse_permission_mode` maps anything unknown onto `Default`, which for a
/// schedule would mean silently running with *more* permission than asked for —
/// so an unrecognised wire value is an error here, not a fallback.
pub fn permission_mode_for(
    provider: &str,
    requested: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(requested) = trimmed(requested) else {
        return Ok(None);
    };
    let parsed = parse_permission_mode(&requested);
    if permission_mode_wire(&parsed) != requested {
        return Err(AppError::BadRequest(format!(
            "unknown collaboration mode '{requested}'"
        )));
    }
    if !provider_supports_mode(provider, &parsed) {
        return Err(AppError::BadRequest(format!(
            "{provider} cannot run in '{requested}' mode"
        )));
    }
    Ok(Some(requested))
}

/// Canonicalize a pinned access mode, dropping it for a provider that has no
/// access axis at all.
///
/// Unlike the collaboration mode this degrades rather than fails: every
/// provider without the axis ignores the column anyway (`runtime_access_mode`
/// filters it the same way), so a schedule that once targeted Codex and now
/// targets Claude keeps running instead of erroring on a knob Claude doesn't
/// have. An unparseable value is still an error — that is a typo, not a
/// provider difference.
pub fn access_mode_for(
    provider: &str,
    requested: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(requested) = trimmed(requested) else {
        return Ok(None);
    };
    let parsed = parse_access_mode_wire(&requested)
        .ok_or_else(|| AppError::BadRequest(format!("unknown access mode '{requested}'")))?;
    let supported = runtime_adapter(provider)
        .map(|adapter| adapter.supports_access_mode(&parsed))
        .unwrap_or(false);
    Ok(supported.then(|| access_mode_wire(&parsed).to_string()))
}

/// Canonicalize a pinned model id (aliases included) against the provider that
/// will run it.
///
/// Resolved from the project's own directory and under the profile the run will
/// use: model availability is per-project for providers that read repo-local
/// config, and per-profile for the ones whose endpoint changes with it. An
/// unset pin stays unset — that means "whatever the CLI defaults to", the same
/// as a session started without touching the model picker.
pub async fn model_for(
    read_pool: &sqlx::SqlitePool,
    project_path: Option<&str>,
    provider: &str,
    requested: Option<&str>,
    profile: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(requested) = trimmed(requested) else {
        return Ok(None);
    };
    let profile = profile
        .map(str::to_string)
        .or_else(|| profile_for_new_session(provider));
    let (model, _entry) = resolve_model_or_error_for_profile(
        read_pool,
        project_path.map(std::path::Path::new),
        provider,
        &requested,
        profile.as_deref(),
    )
    .await
    .map_err(|error| AppError::BadRequest(error.to_string()))?;
    Ok(Some(model))
}

/// The profile a fresh session on this provider would start under, if it has
/// the concept at all.
pub fn profile_for_new_session(provider: &str) -> Option<String> {
    runtime_adapter(provider).and_then(|adapter| adapter.profile_name_for_new_session())
}

pub fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::codex::PROVIDER_ID as CODEX_PROVIDER_ID;

    const CLAUDE: &str = "claude_code";

    #[test]
    fn a_supported_collaboration_mode_passes_through() {
        assert_eq!(
            permission_mode_for(CLAUDE, Some("plan"))
                .unwrap()
                .as_deref(),
            Some("plan")
        );
        assert_eq!(permission_mode_for(CLAUDE, Some("  ")).unwrap(), None);
        assert_eq!(permission_mode_for(CLAUDE, None).unwrap(), None);
    }

    // The bug this guards: `parse_permission_mode` answers `Default` for
    // anything it doesn't know, so without the round-trip check a typo would
    // run the schedule with the provider's default permissions.
    #[test]
    fn an_unknown_collaboration_mode_is_rejected_rather_than_defaulted() {
        let error = permission_mode_for(CLAUDE, Some("plann")).unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    #[test]
    fn an_access_mode_the_provider_lacks_is_dropped_but_a_typo_is_not() {
        assert_eq!(
            access_mode_for(CODEX_PROVIDER_ID, Some("fullAccess"))
                .unwrap()
                .as_deref(),
            Some("fullAccess")
        );
        // Claude Code has no access axis; the pin is inert rather than fatal.
        assert_eq!(access_mode_for(CLAUDE, Some("fullAccess")).unwrap(), None);
        assert!(access_mode_for(CODEX_PROVIDER_ID, Some("nonsense")).is_err());
    }
}
