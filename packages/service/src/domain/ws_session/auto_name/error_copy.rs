use axum::http::StatusCode;
use serde_json::json;

use crate::domain::settings_store::file::{SETTINGS_INVALID, SETTINGS_READ_FAILED};
use crate::error::AppError;

pub(super) enum NamingSetting {
    ProviderSelection,
    ActiveProfile,
    SystemPrompt,
}

impl NamingSetting {
    fn copy(&self) -> (&'static str, &'static str) {
        match self {
            Self::ProviderSelection => (
                "settings_selection",
                "the auto-naming provider, model or active profile",
            ),
            Self::ActiveProfile => ("settings_profile", "the active auto-naming profile"),
            Self::SystemPrompt => ("settings_prompt", "the auto-naming system prompt"),
        }
    }
}

pub(super) fn with_naming_reason(error: AppError, reason: &'static str) -> AppError {
    error.with_public_details(json!({ "auto_name_reason": reason }))
}

pub(super) fn settings_failure(error: AppError, setting: NamingSetting) -> AppError {
    match error {
        // Profile validation can name stored values. Keep the status and code
        // and describe the setting to repair without quoting its contents.
        AppError::Coded { status, code, .. } => {
            let (kind, setting) = setting.copy();
            let reason = match code {
                SETTINGS_READ_FAILED => "could not be read",
                SETTINGS_INVALID => "are invalid",
                _ => "could not be loaded",
            };
            let error = AppError::coded(
                status,
                code,
                format!("The settings for {setting} {reason}. Check them in workspace settings via Edit JSON."),
            );
            with_naming_reason(error, kind)
        }
        AppError::BadRequest(_) | AppError::NotFound(_) => with_naming_reason(
            AppError::coded(
                StatusCode::BAD_REQUEST,
                "AUTO_NAME_PROFILE_FAILED",
                "The auto-naming provider profile is invalid. Check its configuration and try again.",
            ),
            "profile_invalid",
        ),
        other => other,
    }
}

pub(super) fn warning_copy(error: &AppError, reading_title: bool) -> (&str, &str) {
    match error {
        AppError::WithPublicDetails { error, details } => {
            if let Some(reason) = details["auto_name_reason"].as_str() {
                if let AppError::Coded { message, .. } = &**error {
                    return (message, reason);
                }
            }
            retry_from_title_menu()
        }
        AppError::Coded { message, .. } => (message, "by_code"),
        AppError::DatabaseBusy(_) => (
            "The database is busy. Try again in a moment.",
            "database_busy",
        ),
        AppError::DatabaseError(_) | AppError::ConstraintViolation(_) if reading_title => (
            "Cadencr could not read the conversation title. Try again.",
            "database_read_failed",
        ),
        AppError::DatabaseError(_) | AppError::ConstraintViolation(_) => (
            "Cadencr could not save the conversation title. Try again.",
            "database_write_failed",
        ),
        AppError::NotFound(_) => ("The conversation no longer exists.", "conversation_missing"),
        _ => retry_from_title_menu(),
    }
}

fn retry_from_title_menu() -> (&'static str, &'static str) {
    (
        "Try again from the conversation title menu.",
        "retry_from_title_menu",
    )
}
