use crate::error::AppError;
use cadencr_registry_publisher::author_release::Error;
pub(crate) use cadencr_registry_publisher::author_release::{
    ArchiveFile, GitHubArchive, GitHubPublishRequest, GitHubPublishedRelease,
    GitHubReleaseExpectation, GitHubReleaseInspection,
};

impl From<Error> for AppError {
    #[track_caller]
    fn from(error: Error) -> Self {
        match error {
            Error::BadRequest(message) => Self::BadRequest(message),
            Error::Internal(message) => Self::internal(message),
            Error::Coded {
                status,
                code,
                message,
            } => Self::coded(status, code, message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse as _;

    #[test]
    fn shared_errors_preserve_service_display_status_and_codes() {
        let invalid: AppError = Error::BadRequest("invalid source".into()).into();
        assert_eq!(invalid.to_string(), "Bad request: invalid source");
        assert_eq!(invalid.into_response().status(), StatusCode::BAD_REQUEST);
        let internal: AppError = Error::Internal("read failed".into()).into();
        assert_eq!(internal.to_string(), "Internal error: read failed");
        assert_eq!(
            internal.into_response().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        let coded: AppError = Error::Coded {
            status: StatusCode::CONFLICT,
            code: "PUBLICATION_RELEASE_CONFLICT",
            message: "binding changed".into(),
        }
        .into();
        assert!(matches!(coded, AppError::Coded {
            status: StatusCode::CONFLICT, code: "PUBLICATION_RELEASE_CONFLICT", ref message,
        } if message == "binding changed"));
        assert_eq!(coded.to_string(), "binding changed");
        assert_eq!(coded.into_response().status(), StatusCode::CONFLICT);
    }
}
