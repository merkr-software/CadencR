//! Why an update request was refused before anything ran.

use axum::http::StatusCode;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateRequestError {
    NotFound,
    Unsupported,
    InProgress,
    TargetUnsupported,
    UnknownVersion(String),
}

impl From<UpdateRequestError> for AppError {
    #[track_caller]
    fn from(error: UpdateRequestError) -> Self {
        match error {
            UpdateRequestError::NotFound => AppError::coded(
                StatusCode::NOT_FOUND,
                "PROVIDER_NOT_FOUND",
                "no registered provider has this id",
            ),
            UpdateRequestError::Unsupported => AppError::coded(
                StatusCode::CONFLICT,
                "PROVIDER_UPDATE_UNSUPPORTED",
                "this provider does not manage its own updates",
            ),
            UpdateRequestError::InProgress => AppError::coded(
                StatusCode::CONFLICT,
                "PROVIDER_UPDATE_IN_PROGRESS",
                "a version check or update is already running for this provider",
            ),
            UpdateRequestError::TargetUnsupported => AppError::coded(
                StatusCode::BAD_REQUEST,
                "PROVIDER_UPDATE_TARGET_UNSUPPORTED",
                "this provider only installs its latest version",
            ),
            UpdateRequestError::UnknownVersion(version) => AppError::coded(
                StatusCode::BAD_REQUEST,
                "PROVIDER_UPDATE_UNKNOWN_VERSION",
                format!("version {version} is not among the provider's available versions"),
            ),
        }
    }
}
